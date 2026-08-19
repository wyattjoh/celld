// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Pure authorization and lifetime decisions for loaded-worker capabilities.
//!
//! The runtime owns the opaque handle table and the host references. This
//! module owns the small, deterministic policy seam so owner/worker/kind and
//! release behavior can be tested without V8, clocks, locks, or I/O.

/// Stable identity for the host that granted a capability.
pub type OwnerId = u64;

/// Stable identity for the loaded worker that received a capability.
pub type WorkerId = u64;

/// Capability kinds supported by the loaded-worker transport.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityKind {
    /// A host-owned filesystem Workspace.
    Workspace,
    /// An explicitly brokered outbound Fetcher.
    Fetcher,
}

impl CapabilityKind {
    /// Parse the wire spelling of a capability kind.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "workspace" => Some(Self::Workspace),
            "fetcher" => Some(Self::Fetcher),
            _ => None,
        }
    }

    /// Return the stable wire spelling of this kind.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Fetcher => "fetcher",
        }
    }
}

/// The grant metadata retained by the host for one opaque capability handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityGrant {
    /// The host owner that created the grant.
    pub owner: OwnerId,
    /// The one loaded worker that may use the grant.
    pub worker: WorkerId,
    /// The operation family exposed by the grant.
    pub kind: CapabilityKind,
}

/// Why a capability call was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorizationError {
    /// The handle is not in the host registry.
    Unknown,
    /// The caller is not the owner that minted the grant.
    OwnerMismatch,
    /// The handle belongs to a different loaded worker.
    WorkerMismatch,
    /// The requested operation family does not match the grant.
    KindMismatch,
    /// The grant or its loaded worker has been disposed.
    NotLive,
}

/// The stable class of an interruption crossing the loaded-worker boundary.
///
/// These names are part of the runtime error contract. Callers can decide
/// whether a retry is safe without parsing an implementation-specific detail
/// or mistaking a lost host cell for a capability denial.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterruptionClass {
    /// The caller stopped waiting for the capability operation.
    Cancelled,
    /// The bounded handler budget expired before the operation settled.
    TimedOut,
    /// The isolate or its response channel failed while the operation ran.
    IsolateFailure,
    /// The capability rejected the operation or its payload.
    CapabilityFailure,
    /// The host cell lost ownership before the operation could run.
    HostCellLost,
    /// The loaded worker was disposed or finalized.
    WorkerDisposed,
}

impl InterruptionClass {
    /// Stable lowercase spelling used in bounded runtime errors and tests.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::IsolateFailure => "isolate_failure",
            Self::CapabilityFailure => "capability_failure",
            Self::HostCellLost => "host_cell_lost",
            Self::WorkerDisposed => "worker_disposed",
        }
    }
}

/// Check the immutable identity fields and liveness for one call.
pub fn authorize(
    grant: Option<CapabilityGrant>,
    owner: OwnerId,
    worker: WorkerId,
    kind: CapabilityKind,
    live: bool,
) -> Result<CapabilityGrant, AuthorizationError> {
    let grant = grant.ok_or(AuthorizationError::Unknown)?;
    if !live {
        return Err(AuthorizationError::NotLive);
    }
    if grant.owner != owner {
        return Err(AuthorizationError::OwnerMismatch);
    }
    if grant.worker != worker {
        return Err(AuthorizationError::WorkerMismatch);
    }
    if grant.kind != kind {
        return Err(AuthorizationError::KindMismatch);
    }
    Ok(grant)
}

/// Deterministic lifetime state for one capability grant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Lifetime {
    live: bool,
    in_flight: usize,
}

impl Lifetime {
    /// Create a live grant with no calls in flight.
    pub const fn live() -> Self {
        Self {
            live: true,
            in_flight: 0,
        }
    }

    /// Whether new calls may start.
    pub const fn is_live(self) -> bool {
        self.live
    }

    /// Number of calls that must settle before host references can release.
    pub const fn in_flight(self) -> usize {
        self.in_flight
    }

    /// Admit one call, rejecting it after disposal.
    pub fn begin(&mut self) -> Result<(), AuthorizationError> {
        if !self.live {
            return Err(AuthorizationError::NotLive);
        }
        self.in_flight = self.in_flight.saturating_add(1);
        Ok(())
    }

    /// Mark the grant disposed. Existing calls remain allowed to settle.
    pub fn dispose(&mut self) {
        self.live = false;
    }

    /// Finish one call and report whether a disposed grant can release now.
    pub fn finish(&mut self) -> bool {
        self.in_flight = self.in_flight.saturating_sub(1);
        !self.live && self.in_flight == 0
    }

    /// Whether the host reference can be released immediately.
    pub const fn releasable(self) -> bool {
        !self.live && self.in_flight == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRANT: CapabilityGrant = CapabilityGrant {
        owner: 7,
        worker: 11,
        kind: CapabilityKind::Workspace,
    };

    #[test]
    fn authorization_is_scoped_to_owner_worker_and_kind() {
        assert_eq!(
            authorize(Some(GRANT), 7, 11, CapabilityKind::Workspace, true),
            Ok(GRANT)
        );
        assert_eq!(
            authorize(Some(GRANT), 8, 11, CapabilityKind::Workspace, true),
            Err(AuthorizationError::OwnerMismatch)
        );
        assert_eq!(
            authorize(Some(GRANT), 7, 12, CapabilityKind::Workspace, true),
            Err(AuthorizationError::WorkerMismatch)
        );
        assert_eq!(
            authorize(Some(GRANT), 7, 11, CapabilityKind::Fetcher, true),
            Err(AuthorizationError::KindMismatch)
        );
        assert_eq!(
            authorize(Some(GRANT), 7, 11, CapabilityKind::Workspace, false),
            Err(AuthorizationError::NotLive)
        );
        assert_eq!(
            authorize(None, 7, 11, CapabilityKind::Workspace, true),
            Err(AuthorizationError::Unknown)
        );
    }

    #[test]
    fn disposal_waits_for_in_flight_calls_before_release() {
        let mut lifetime = Lifetime::live();
        lifetime.begin().unwrap();
        lifetime.begin().unwrap();
        lifetime.dispose();
        assert!(!lifetime.is_live());
        assert_eq!(lifetime.in_flight(), 2);
        assert!(!lifetime.releasable());
        assert!(!lifetime.finish());
        assert!(lifetime.finish());
        assert!(lifetime.releasable());
        assert_eq!(lifetime.begin(), Err(AuthorizationError::NotLive));
    }

    #[test]
    fn interruption_classes_have_stable_distinct_names() {
        let classes = [
            InterruptionClass::Cancelled,
            InterruptionClass::TimedOut,
            InterruptionClass::IsolateFailure,
            InterruptionClass::CapabilityFailure,
            InterruptionClass::HostCellLost,
            InterruptionClass::WorkerDisposed,
        ];
        let names: std::collections::BTreeSet<_> =
            classes.into_iter().map(InterruptionClass::as_str).collect();
        assert_eq!(names.len(), classes.len());
        assert!(names.contains("host_cell_lost"));
        assert!(names.contains("worker_disposed"));
    }
}
