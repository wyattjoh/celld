// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Pure admission and shedding decisions for Worker Loader Code Mode.
//!
//! This module deliberately knows nothing about V8, clocks, environment
//! variables, or the owning cell. The runtime supplies the configured limits
//! and current process-memory sample, then applies the returned decision. A
//! Code Mode worker is disposable compute; its Workspace and Agent state are
//! not part of this state machine and therefore cannot be shed accidentally.

/// The fixed protocol limits inherited from the Worker Loader contract.
pub const DEFAULT_MAX_CODE_BYTES: usize = 64 * 1024 * 1024;
/// The fixed protocol limit inherited from the Worker Loader contract.
pub const DEFAULT_MAX_ENV_BYTES: usize = 1024 * 1024;
/// Default number of loaded-worker calls that may execute at once.
pub const DEFAULT_MAX_CONCURRENT_EXECUTIONS: usize = 64;
/// Default loaded-worker execution timeout in milliseconds.
pub const DEFAULT_EXECUTION_TIMEOUT_MS: u64 = 300_000;
/// Stable error returned when a loaded-worker response outlives its budget.
pub const EXECUTION_TIMEOUT_ERROR: &str = "worker loader: execution time limit exceeded";

/// Configured Code Mode admission limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Maximum combined bytes in the loaded worker's modules.
    pub max_code_bytes: usize,
    /// Maximum serialized bytes in the loaded worker's plain JSON env.
    pub max_env_bytes: usize,
    /// Maximum loaded workers retained by the node.
    pub max_workers: usize,
    /// Maximum concurrent loaded-worker calls across the node.
    pub max_concurrent_executions: usize,
    /// Wall-clock budget for one loaded-worker response, in milliseconds.
    pub execution_timeout_ms: u64,
    /// Memory reservation charged for one loaded worker.
    pub worker_memory_bytes: u64,
    /// Maximum process memory admitted for Code Mode, if configured.
    pub max_memory_bytes: Option<u64>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_code_bytes: DEFAULT_MAX_CODE_BYTES,
            max_env_bytes: DEFAULT_MAX_ENV_BYTES,
            max_workers: 256,
            max_concurrent_executions: DEFAULT_MAX_CONCURRENT_EXECUTIONS,
            execution_timeout_ms: DEFAULT_EXECUTION_TIMEOUT_MS,
            worker_memory_bytes: 0,
            max_memory_bytes: None,
        }
    }
}

/// A process-memory observation supplied by the runtime.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemorySample {
    /// Bytes currently resident in the process.
    pub resident_bytes: u64,
}

/// Mutable counters used by the pure admission policy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    /// Workers currently retained in the loader registry.
    pub workers: usize,
    /// Calls currently executing in loaded workers or their host capability
    /// dispatch.
    pub executions: usize,
    /// Reserved memory for retained workers and their pending calls.
    pub reserved_memory_bytes: u64,
    /// The last process-memory sample supplied by the runtime.
    pub observed_memory_bytes: u64,
    /// Whether new Code Mode work is being shed.
    pub pressured: bool,
}

/// A request to retain one loaded worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkerRequest {
    /// Combined module bytes.
    pub code_bytes: usize,
    /// Serialized plain JSON environment bytes.
    pub env_bytes: usize,
    /// Memory reservation charged to this worker.
    pub memory_bytes: u64,
}

/// A reservation returned after worker admission succeeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkerReservation {
    /// The reservation that must be released when the worker is disposed.
    pub memory_bytes: u64,
}

/// A reservation returned after execution admission succeeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExecutionReservation;

/// A distinct reason Code Mode work was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionError {
    /// The module payload is too large.
    CodeSize { actual: usize, limit: usize },
    /// The plain JSON environment is too large.
    EnvSize { actual: usize, limit: usize },
    /// The node already retains its worker ceiling.
    WorkerLimit { active: usize, limit: usize },
    /// The node already runs its execution ceiling.
    ConcurrencyLimit { active: usize, limit: usize },
    /// The process-memory budget cannot safely hold another worker.
    MemoryLimit {
        observed: u64,
        reserved: u64,
        requested: u64,
        limit: u64,
    },
    /// The node is shedding new Code Mode work under pressure.
    Pressured,
}

/// Pure Code Mode admission state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admission {
    limits: Limits,
    usage: Usage,
}

impl Admission {
    /// Create an empty admission state with `limits`.
    pub const fn new(limits: Limits) -> Self {
        Self {
            limits,
            usage: Usage {
                workers: 0,
                executions: 0,
                reserved_memory_bytes: 0,
                observed_memory_bytes: 0,
                pressured: false,
            },
        }
    }

    /// Return the configured limits.
    pub const fn limits(self) -> Limits {
        self.limits
    }

    /// Return the current counters.
    pub const fn usage(self) -> Usage {
        self.usage
    }

    /// Update the process-memory sample used by future worker admissions.
    pub fn observe_memory(&mut self, sample: MemorySample) {
        self.usage.observed_memory_bytes = sample.resident_bytes;
    }

    /// Replace the effective process-memory ceiling without resetting usage.
    pub fn set_max_memory_bytes(&mut self, limit: Option<u64>) {
        self.limits.max_memory_bytes = limit;
    }

    /// Enable or disable pressure shedding for new Code Mode work.
    pub fn set_pressured(&mut self, pressured: bool) {
        self.usage.pressured = pressured;
    }

    /// Admit one loaded worker, atomically checking every worker bound.
    pub fn admit_worker(
        &mut self,
        request: WorkerRequest,
    ) -> Result<WorkerReservation, AdmissionError> {
        if request.code_bytes > self.limits.max_code_bytes {
            return Err(AdmissionError::CodeSize {
                actual: request.code_bytes,
                limit: self.limits.max_code_bytes,
            });
        }
        if request.env_bytes > self.limits.max_env_bytes {
            return Err(AdmissionError::EnvSize {
                actual: request.env_bytes,
                limit: self.limits.max_env_bytes,
            });
        }
        if self.usage.pressured {
            return Err(AdmissionError::Pressured);
        }
        if self.usage.workers >= self.limits.max_workers {
            return Err(AdmissionError::WorkerLimit {
                active: self.usage.workers,
                limit: self.limits.max_workers,
            });
        }
        if let Some(limit) = self.limits.max_memory_bytes {
            let used = self
                .usage
                .observed_memory_bytes
                .saturating_add(self.usage.reserved_memory_bytes);
            if used.saturating_add(request.memory_bytes) > limit {
                return Err(AdmissionError::MemoryLimit {
                    observed: self.usage.observed_memory_bytes,
                    reserved: self.usage.reserved_memory_bytes,
                    requested: request.memory_bytes,
                    limit,
                });
            }
        }
        self.usage.workers = self.usage.workers.saturating_add(1);
        self.usage.reserved_memory_bytes = self
            .usage
            .reserved_memory_bytes
            .saturating_add(request.memory_bytes);
        Ok(WorkerReservation {
            memory_bytes: request.memory_bytes,
        })
    }

    /// Release a previously admitted worker after its isolate and host
    /// capability references have finished disposing.
    pub fn release_worker(&mut self, reservation: WorkerReservation) {
        self.usage.workers = self.usage.workers.saturating_sub(1);
        self.usage.reserved_memory_bytes = self
            .usage
            .reserved_memory_bytes
            .saturating_sub(reservation.memory_bytes);
    }

    /// Admit one loaded-worker fetch, RPC, or capability call.
    pub fn admit_execution(&mut self) -> Result<ExecutionReservation, AdmissionError> {
        if self.usage.pressured {
            return Err(AdmissionError::Pressured);
        }
        if self.usage.executions >= self.limits.max_concurrent_executions {
            return Err(AdmissionError::ConcurrencyLimit {
                active: self.usage.executions,
                limit: self.limits.max_concurrent_executions,
            });
        }
        self.usage.executions = self.usage.executions.saturating_add(1);
        Ok(ExecutionReservation)
    }

    /// Release a previously admitted loaded-worker call.
    pub fn release_execution(&mut self, _reservation: ExecutionReservation) {
        self.usage.executions = self.usage.executions.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            max_code_bytes: 10,
            max_env_bytes: 5,
            max_workers: 2,
            max_concurrent_executions: 1,
            execution_timeout_ms: 25,
            worker_memory_bytes: 4,
            max_memory_bytes: Some(20),
        }
    }

    #[test]
    fn worker_admission_reports_each_bound_without_mutating_authoritative_usage() {
        let mut admission = Admission::new(limits());
        admission.observe_memory(MemorySample { resident_bytes: 10 });

        assert_eq!(
            admission.admit_worker(WorkerRequest {
                code_bytes: 11,
                env_bytes: 0,
                memory_bytes: 1,
            }),
            Err(AdmissionError::CodeSize {
                actual: 11,
                limit: 10,
            })
        );
        assert_eq!(
            admission.admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 6,
                memory_bytes: 1,
            }),
            Err(AdmissionError::EnvSize {
                actual: 6,
                limit: 5
            })
        );
        assert_eq!(admission.usage().workers, 0);
        assert_eq!(admission.usage().reserved_memory_bytes, 0);

        let first = admission
            .admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 1,
                memory_bytes: 4,
            })
            .expect("first worker admitted");
        assert_eq!(admission.usage().workers, 1);
        assert_eq!(admission.usage().reserved_memory_bytes, 4);
        assert_eq!(
            admission.admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 1,
                memory_bytes: 7,
            }),
            Err(AdmissionError::MemoryLimit {
                observed: 10,
                reserved: 4,
                requested: 7,
                limit: 20,
            })
        );
        admission.release_worker(first);
        assert_eq!(admission.usage().workers, 0);
        assert_eq!(admission.usage().reserved_memory_bytes, 0);
    }

    #[test]
    fn worker_and_execution_limits_are_distinct_and_pressure_only_sheds_new_work() {
        let mut admission = Admission::new(limits());
        let first = admission
            .admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 1,
                memory_bytes: 1,
            })
            .unwrap();
        let second = admission
            .admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 1,
                memory_bytes: 1,
            })
            .unwrap();
        assert_eq!(
            admission.admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 1,
                memory_bytes: 1,
            }),
            Err(AdmissionError::WorkerLimit {
                active: 2,
                limit: 2,
            })
        );

        let execution = admission.admit_execution().unwrap();
        assert_eq!(
            admission.admit_execution(),
            Err(AdmissionError::ConcurrencyLimit {
                active: 1,
                limit: 1,
            })
        );
        admission.set_pressured(true);
        assert_eq!(admission.admit_execution(), Err(AdmissionError::Pressured));
        assert_eq!(
            admission.admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 1,
                memory_bytes: 1,
            }),
            Err(AdmissionError::Pressured)
        );
        assert_eq!(admission.usage().workers, 2);
        assert_eq!(admission.usage().executions, 1);

        admission.release_execution(execution);
        admission.release_worker(first);
        admission.release_worker(second);
        assert_eq!(
            admission.usage(),
            Usage {
                pressured: true,
                ..Usage::default()
            }
        );
    }

    #[test]
    fn a_disposed_worker_can_finish_its_authorized_call_before_release() {
        let mut admission = Admission::new(limits());
        let worker = admission
            .admit_worker(WorkerRequest {
                code_bytes: 1,
                env_bytes: 1,
                memory_bytes: 1,
            })
            .unwrap();
        let execution = admission.admit_execution().unwrap();
        admission.set_pressured(true);
        admission.release_execution(execution);
        admission.release_worker(worker);
        assert_eq!(admission.usage().workers, 0);
        assert_eq!(admission.usage().executions, 0);
        assert!(admission.usage().pressured);
    }
}
