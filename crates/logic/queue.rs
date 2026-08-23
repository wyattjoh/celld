// Copyright 2026 Deno Land Inc. Apache-2.0 license.

//! Cloudflare Queues policy, reified sans-IO.
//!
//! Queue cells and JavaScript bindings execute the decisions made here. This
//! module owns the deploy defaults, queue-name contract, batch alarm policy,
//! retry ceiling, and delay precedence. It deliberately has no storage,
//! clocks, randomness, or runtime dependencies.

use crate::Ms;
use std::fmt;

/// The class name of every reserved queue cell.
pub const RESERVED_CLASS: &str = ".queue";
/// Cloudflare's maximum queue-name length.
pub const MAX_QUEUE_NAME_LENGTH: usize = 63;
/// Cloudflare's maximum message and retry delay, in seconds.
pub const MAX_DELAY_SECONDS: u32 = 86_400;

/// Cloudflare's deploy-time producer default.
pub const DEFAULT_DELIVERY_DELAY: u32 = 0;
/// Cloudflare's deploy-time batch-size default.
pub const DEFAULT_MAX_BATCH_SIZE: u16 = 10;
/// Cloudflare's deploy-time batch-timeout default, in seconds.
pub const DEFAULT_MAX_BATCH_TIMEOUT: u32 = 5;
/// Cloudflare's deploy-time retry-ceiling default.
pub const DEFAULT_MAX_RETRIES: u16 = 3;
/// Cloudflare's deploy-time retry-delay default, in seconds.
pub const DEFAULT_RETRY_DELAY: u32 = 0;

/// The keys modeled in a `queues.producers[]` entry.
pub const SUPPORTED_PRODUCER_KEYS: &[&str] = &["queue", "binding", "delivery_delay"];
/// The keys modeled in a `queues.consumers[]` entry.
pub const SUPPORTED_CONSUMER_KEYS: &[&str] = &[
    "queue",
    "max_batch_size",
    "max_batch_timeout",
    "max_retries",
    "retry_delay",
];
/// Cloudflare queue keys which celld recognizes but deliberately rejects.
///
/// `type` and `visibility_timeout_ms` are pull-consumer settings. The remaining
/// two settings require machinery outside the one-in-flight-batch baseline.
pub const REJECTED_CONSUMER_KEYS: &[&str] = &[
    "dead_letter_queue",
    "max_concurrency",
    "type",
    "visibility_timeout_ms",
];

/// Which queue config array contains a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueConfigSection {
    Producer,
    Consumer,
}

impl QueueConfigSection {
    /// Return the Wrangler spelling of this section.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Producer => "producers",
            Self::Consumer => "consumers",
        }
    }
}

/// A recognized out-of-scope queue key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectedQueueKey {
    DeadLetterQueue,
    MaxConcurrency,
    PullConsumerType,
    PullVisibilityTimeout,
}

impl RejectedQueueKey {
    /// Return the reason's stable short name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DeadLetterQueue => "dead_letter_queue",
            Self::MaxConcurrency => "max_concurrency",
            Self::PullConsumerType => "type",
            Self::PullVisibilityTimeout => "visibility_timeout_ms",
        }
    }
}

/// The policy verdict for one key before the deploy adapter inspects its
/// value. Unknown keys are distinct from known-but-rejected keys so deploy can
/// give the operator a useful compatibility error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueKeyVerdict {
    Supported,
    Rejected(RejectedQueueKey),
    Unknown,
}

/// Return the strict allowlist verdict for one queue config key.
pub fn config_key_verdict(section: QueueConfigSection, key: &str) -> QueueKeyVerdict {
    let supported = match section {
        QueueConfigSection::Producer => SUPPORTED_PRODUCER_KEYS,
        QueueConfigSection::Consumer => SUPPORTED_CONSUMER_KEYS,
    };
    if supported.contains(&key) {
        return QueueKeyVerdict::Supported;
    }
    if section == QueueConfigSection::Consumer {
        let rejected = match key {
            "dead_letter_queue" => Some(RejectedQueueKey::DeadLetterQueue),
            "max_concurrency" => Some(RejectedQueueKey::MaxConcurrency),
            "type" => Some(RejectedQueueKey::PullConsumerType),
            "visibility_timeout_ms" => Some(RejectedQueueKey::PullVisibilityTimeout),
            _ => None,
        };
        if let Some(rejected) = rejected {
            return QueueKeyVerdict::Rejected(rejected);
        }
    }
    QueueKeyVerdict::Unknown
}

/// A loud rejection from the queue config allowlist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueKeyError {
    /// A known Cloudflare key is outside the baseline.
    Rejected {
        section: QueueConfigSection,
        key: String,
        reason: RejectedQueueKey,
    },
    /// The key is not part of the modeled Cloudflare subset.
    Unknown {
        section: QueueConfigSection,
        key: String,
    },
}

impl fmt::Display for QueueKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected {
                section,
                key,
                reason,
            } => write!(
                f,
                "queues.{} key {:?} is not supported by celld ({})",
                section.as_str(),
                key,
                reason.as_str()
            ),
            Self::Unknown { section, key } => {
                write!(f, "unknown queues.{} key {:?}", section.as_str(), key)
            }
        }
    }
}

impl std::error::Error for QueueKeyError {}

/// Validate one key and return an actionable error for every non-supported
/// verdict. Values such as `type: "http_pull"` are rejected by the key
/// allowlist before an adapter can silently ignore them.
pub fn validate_config_key(section: QueueConfigSection, key: &str) -> Result<(), QueueKeyError> {
    match config_key_verdict(section, key) {
        QueueKeyVerdict::Supported => Ok(()),
        QueueKeyVerdict::Rejected(reason) => Err(QueueKeyError::Rejected {
            section,
            key: key.to_string(),
            reason,
        }),
        QueueKeyVerdict::Unknown => Err(QueueKeyError::Unknown {
            section,
            key: key.to_string(),
        }),
    }
}

/// Optional values from a `queues.producers[]` entry before defaults are
/// resolved. Signed values let the pure validator report negative JSON numbers
/// instead of relying on a serde conversion failure in the adapter.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProducerOptions {
    /// Default delay for messages sent through this producer binding, in
    /// seconds.
    pub delivery_delay: Option<i64>,
}

/// Fully resolved producer settings stored in a deployment manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProducerConfig {
    /// Default delay for messages sent through this producer binding, in
    /// seconds.
    pub delivery_delay: u32,
}

impl Default for ProducerConfig {
    fn default() -> Self {
        Self {
            delivery_delay: DEFAULT_DELIVERY_DELAY,
        }
    }
}

/// Optional values from a `queues.consumers[]` entry before defaults are
/// resolved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConsumerOptions {
    /// Maximum number of visible messages in one delivery batch.
    pub max_batch_size: Option<i64>,
    /// Maximum batch window, in seconds.
    pub max_batch_timeout: Option<i64>,
    /// Delivery-attempt ceiling used by the settled queue policy.
    pub max_retries: Option<i64>,
    /// Default retry delay, in seconds.
    pub retry_delay: Option<i64>,
}

/// Fully resolved consumer settings stored in a deployment manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsumerConfig {
    /// Maximum number of visible messages in one delivery batch.
    pub max_batch_size: u16,
    /// Maximum batch window, in seconds.
    pub max_batch_timeout: u32,
    /// Delivery-attempt ceiling used by the settled queue policy.
    pub max_retries: u16,
    /// Default retry delay, in seconds.
    pub retry_delay: u32,
}

impl Default for ConsumerConfig {
    fn default() -> Self {
        Self {
            max_batch_size: DEFAULT_MAX_BATCH_SIZE,
            max_batch_timeout: DEFAULT_MAX_BATCH_TIMEOUT,
            max_retries: DEFAULT_MAX_RETRIES,
            retry_delay: DEFAULT_RETRY_DELAY,
        }
    }
}

/// The numeric field that failed queue config validation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigField {
    DeliveryDelay,
    MaxBatchSize,
    MaxBatchTimeout,
    MaxRetries,
    RetryDelay,
}

impl ConfigField {
    /// Return the exact Wrangler key.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DeliveryDelay => "delivery_delay",
            Self::MaxBatchSize => "max_batch_size",
            Self::MaxBatchTimeout => "max_batch_timeout",
            Self::MaxRetries => "max_retries",
            Self::RetryDelay => "retry_delay",
        }
    }
}

/// Why a deploy-time queue value was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    OutOfRange {
        field: ConfigField,
        value: i64,
        min: i64,
        max: i64,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self::OutOfRange {
            field,
            value,
            min,
            max,
        } = self;
        write!(
            f,
            "queue config {}={} is outside {}..={}",
            field.as_str(),
            value,
            min,
            max
        )
    }
}

impl std::error::Error for ConfigError {}

/// Resolve a producer entry with Cloudflare's defaults and bounds.
pub fn resolve_producer(options: ProducerOptions) -> Result<ProducerConfig, ConfigError> {
    Ok(ProducerConfig {
        delivery_delay: resolve_u32(
            ConfigField::DeliveryDelay,
            options.delivery_delay,
            i64::from(DEFAULT_DELIVERY_DELAY),
            0,
            i64::from(MAX_DELAY_SECONDS),
        )?,
    })
}

/// Resolve a consumer entry with Cloudflare's defaults and bounds.
pub fn resolve_consumer(options: ConsumerOptions) -> Result<ConsumerConfig, ConfigError> {
    Ok(ConsumerConfig {
        max_batch_size: resolve_u16(
            ConfigField::MaxBatchSize,
            options.max_batch_size,
            i64::from(DEFAULT_MAX_BATCH_SIZE),
            1,
            100,
        )?,
        max_batch_timeout: resolve_u32(
            ConfigField::MaxBatchTimeout,
            options.max_batch_timeout,
            i64::from(DEFAULT_MAX_BATCH_TIMEOUT),
            0,
            60,
        )?,
        max_retries: resolve_u16(
            ConfigField::MaxRetries,
            options.max_retries,
            i64::from(DEFAULT_MAX_RETRIES),
            0,
            100,
        )?,
        retry_delay: resolve_u32(
            ConfigField::RetryDelay,
            options.retry_delay,
            i64::from(DEFAULT_RETRY_DELAY),
            0,
            i64::from(MAX_DELAY_SECONDS),
        )?,
    })
}

fn resolve_u32(
    field: ConfigField,
    value: Option<i64>,
    default: i64,
    min: i64,
    max: i64,
) -> Result<u32, ConfigError> {
    let value = value.unwrap_or(default);
    if !(min..=max).contains(&value) {
        return Err(ConfigError::OutOfRange {
            field,
            value,
            min,
            max,
        });
    }
    Ok(value as u32)
}

fn resolve_u16(
    field: ConfigField,
    value: Option<i64>,
    default: i64,
    min: i64,
    max: i64,
) -> Result<u16, ConfigError> {
    let value = value.unwrap_or(default);
    if !(min..=max).contains(&value) {
        return Err(ConfigError::OutOfRange {
            field,
            value,
            min,
            max,
        });
    }
    Ok(value as u16)
}

/// Why a queue name was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueNameError {
    Empty,
    TooLong { length: usize, max: usize },
    InvalidStart { character: char },
    InvalidEnd { character: char },
    InvalidCharacter { character: char },
}

impl fmt::Display for QueueNameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "queue name is empty"),
            Self::TooLong { length, max } => {
                write!(f, "queue name has {length} bytes; maximum is {max}")
            }
            Self::InvalidStart { character } => {
                write!(f, "queue name starts with invalid character {character:?}")
            }
            Self::InvalidEnd { character } => {
                write!(f, "queue name ends with invalid character {character:?}")
            }
            Self::InvalidCharacter { character } => {
                write!(f, "queue name contains invalid character {character:?}")
            }
        }
    }
}

impl std::error::Error for QueueNameError {}

/// Validate a Cloudflare queue name: one to 63 ASCII lowercase letters,
/// digits, or hyphens, with an alphanumeric first and last character.
pub fn validate_name(name: &str) -> Result<(), QueueNameError> {
    if name.is_empty() {
        return Err(QueueNameError::Empty);
    }
    if name.len() > MAX_QUEUE_NAME_LENGTH {
        return Err(QueueNameError::TooLong {
            length: name.len(),
            max: MAX_QUEUE_NAME_LENGTH,
        });
    }
    if let Some(character) = name
        .chars()
        .find(|character| !is_name_character(*character))
    {
        return Err(QueueNameError::InvalidCharacter { character });
    }
    let first = name.chars().next().expect("name was checked non-empty");
    if !is_alphanumeric(first) {
        return Err(QueueNameError::InvalidStart { character: first });
    }
    let last = name
        .chars()
        .next_back()
        .expect("name was checked non-empty");
    if !is_alphanumeric(last) {
        return Err(QueueNameError::InvalidEnd { character: last });
    }
    Ok(())
}

fn is_name_character(character: char) -> bool {
    is_alphanumeric(character) || character == '-'
}

fn is_alphanumeric(character: char) -> bool {
    character.is_ascii_lowercase() || character.is_ascii_digit()
}

/// Return the fleet-global reserved cell name for a queue.
pub fn reserved_cell(name: &str) -> String {
    format!("{RESERVED_CLASS}:{name}")
}

/// What an alarm should do with the current queue backlog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchDecision {
    /// There is no backlog that needs an alarm.
    Idle,
    /// The size or timeout window is satisfied; invoke the consumer now.
    DeliverNow,
    /// Keep the cell asleep until this millisecond timestamp.
    ArmAt(Ms),
}

/// Decide whether a queue alarm delivers, waits for a batch window, or idles.
///
/// `earliest_visible_at_ms` is the earliest queued message, not necessarily a
/// currently visible message. A non-empty queue with no visible messages arms
/// at that timestamp; a visible batch starts its timeout window at the head's
/// visibility time. The adapter supplies the count from the same transaction
/// that reads the earliest timestamp.
pub fn batch_decision(
    now_ms: Ms,
    visible_count: usize,
    earliest_visible_at_ms: Option<Ms>,
    next_visible_at_ms: Option<Ms>,
    config: &ConsumerConfig,
) -> BatchDecision {
    let Some(earliest_visible_at_ms) = earliest_visible_at_ms else {
        return BatchDecision::Idle;
    };

    if visible_count == 0 {
        return if earliest_visible_at_ms > now_ms {
            BatchDecision::ArmAt(earliest_visible_at_ms)
        } else {
            BatchDecision::Idle
        };
    }
    if visible_count >= usize::from(config.max_batch_size) {
        return BatchDecision::DeliverNow;
    }
    if now_ms < earliest_visible_at_ms {
        return BatchDecision::ArmAt(earliest_visible_at_ms);
    }

    let timeout_ms = i64::from(config.max_batch_timeout).saturating_mul(1_000);
    let deadline = earliest_visible_at_ms.saturating_add(timeout_ms);
    let wake_at = next_visible_at_ms.map_or(deadline, |visible_at| deadline.min(visible_at));
    if now_ms >= wake_at {
        BatchDecision::DeliverNow
    } else {
        BatchDecision::ArmAt(wake_at)
    }
}

/// The result of durably incrementing a message's delivery-attempt counter at
/// claim time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimDecision {
    /// The incremented message may be handed to the consumer.
    Deliver { attempts: u16 },
    /// The incremented message has crossed the configured ceiling and should
    /// be dropped with queue telemetry.
    Drop { attempts: u16 },
}

/// Increment a stored attempt count and apply the settled `max_retries`
/// ceiling. `max_retries` counts redeliveries after the first delivery, so a
/// value of three permits four handler attempts. Infrastructure failures before
/// claim do not call this function and therefore do not consume an attempt.
pub fn claim_attempt(stored_attempts: u16, max_retries: u16) -> ClaimDecision {
    let attempts = stored_attempts.saturating_add(1);
    let max_attempts = max_retries.saturating_add(1);
    if attempts > max_attempts {
        ClaimDecision::Drop { attempts }
    } else {
        ClaimDecision::Deliver { attempts }
    }
}

/// Clamp an explicit or configured delay to Cloudflare's 24-hour range.
pub fn clamp_delay_seconds(delay_seconds: i64) -> u32 {
    delay_seconds.clamp(0, i64::from(MAX_DELAY_SECONDS)) as u32
}

/// Resolve the queue delay precedence chain.
///
/// `Some(0)` is an explicit no-delay override. The first present value wins:
/// per-message, then per-call (`sendBatch`/`retryAll`), then the configured
/// producer or consumer default.
pub fn resolve_delay_seconds(
    per_message: Option<i64>,
    per_call: Option<i64>,
    configured: Option<i64>,
) -> u32 {
    let selected = per_message.or(per_call).or(configured).unwrap_or(0);
    clamp_delay_seconds(selected)
}

/// Resolve a producer send delay against its binding default.
pub fn producer_delay_seconds(
    per_message: Option<i64>,
    per_call: Option<i64>,
    config: &ProducerConfig,
) -> u32 {
    resolve_delay_seconds(
        per_message,
        per_call,
        Some(i64::from(config.delivery_delay)),
    )
}

/// Resolve a consumer retry delay against its `retry_delay` default.
pub fn retry_delay_seconds(
    per_message: Option<i64>,
    per_call: Option<i64>,
    config: &ConsumerConfig,
) -> u32 {
    resolve_delay_seconds(per_message, per_call, Some(i64::from(config.retry_delay)))
}

/// Convert a relative delay into the queue row's absolute visibility time.
pub fn visible_at_ms(now_ms: Ms, delay_seconds: i64) -> Ms {
    let delay_ms = i64::from(clamp_delay_seconds(delay_seconds)).saturating_mul(1_000);
    now_ms.saturating_add(delay_ms)
}

/// Compute a retried message's visibility time using the consumer retry
/// default and the same precedence chain as Cloudflare.
pub fn retry_visible_at_ms(
    now_ms: Ms,
    per_message: Option<i64>,
    per_call: Option<i64>,
    config: &ConsumerConfig,
) -> Ms {
    visible_at_ms(
        now_ms,
        i64::from(retry_delay_seconds(per_message, per_call, config)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consumer_config() -> ConsumerConfig {
        ConsumerConfig {
            max_batch_size: 10,
            max_batch_timeout: 5,
            max_retries: 3,
            retry_delay: 12,
        }
    }

    #[test]
    fn batch_formation_is_a_table_driven_size_timeout_and_visibility_race() {
        struct Case {
            name: &'static str,
            now_ms: Ms,
            visible_count: usize,
            earliest_visible_at_ms: Option<Ms>,
            next_visible_at_ms: Option<Ms>,
            config: ConsumerConfig,
            expected: BatchDecision,
        }

        let mut zero_timeout = consumer_config();
        zero_timeout.max_batch_timeout = 0;
        let cases = [
            Case {
                name: "empty queue idles",
                now_ms: 1_000,
                visible_count: 0,
                earliest_visible_at_ms: None,
                next_visible_at_ms: None,
                config: consumer_config(),
                expected: BatchDecision::Idle,
            },
            Case {
                name: "delayed head arms at visibility",
                now_ms: 1_000,
                visible_count: 0,
                earliest_visible_at_ms: Some(4_000),
                next_visible_at_ms: Some(4_000),
                config: consumer_config(),
                expected: BatchDecision::ArmAt(4_000),
            },
            Case {
                name: "due head with no visible rows is inconsistent and idles",
                now_ms: 4_000,
                visible_count: 0,
                earliest_visible_at_ms: Some(4_000),
                next_visible_at_ms: None,
                config: consumer_config(),
                expected: BatchDecision::Idle,
            },
            Case {
                name: "size threshold delivers immediately",
                now_ms: 1_000,
                visible_count: 10,
                earliest_visible_at_ms: Some(1_000),
                next_visible_at_ms: None,
                config: consumer_config(),
                expected: BatchDecision::DeliverNow,
            },
            Case {
                name: "partial visible batch arms its window",
                now_ms: 1_000,
                visible_count: 1,
                earliest_visible_at_ms: Some(1_000),
                next_visible_at_ms: None,
                config: consumer_config(),
                expected: BatchDecision::ArmAt(6_000),
            },
            Case {
                name: "before delayed head arms at the head",
                now_ms: 1_000,
                visible_count: 1,
                earliest_visible_at_ms: Some(4_000),
                next_visible_at_ms: Some(4_000),
                config: consumer_config(),
                expected: BatchDecision::ArmAt(4_000),
            },
            Case {
                name: "timeout deadline delivers",
                now_ms: 6_000,
                visible_count: 1,
                earliest_visible_at_ms: Some(1_000),
                next_visible_at_ms: None,
                config: consumer_config(),
                expected: BatchDecision::DeliverNow,
            },
            Case {
                name: "a newly visible message wakes before the timeout",
                now_ms: 1_000,
                visible_count: 1,
                earliest_visible_at_ms: Some(1_000),
                next_visible_at_ms: Some(2_000),
                config: consumer_config(),
                expected: BatchDecision::ArmAt(2_000),
            },
            Case {
                name: "zero timeout delivers the first visible message",
                now_ms: 1_000,
                visible_count: 1,
                earliest_visible_at_ms: Some(1_000),
                next_visible_at_ms: None,
                config: zero_timeout,
                expected: BatchDecision::DeliverNow,
            },
        ];

        for case in cases {
            assert_eq!(
                batch_decision(
                    case.now_ms,
                    case.visible_count,
                    case.earliest_visible_at_ms,
                    case.next_visible_at_ms,
                    &case.config,
                ),
                case.expected,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn retry_claims_increment_before_delivery_and_drop_at_the_ceiling() {
        struct Case {
            name: &'static str,
            stored_attempts: u16,
            max_retries: u16,
            expected: ClaimDecision,
        }

        let cases = [
            Case {
                name: "first claim",
                stored_attempts: 0,
                max_retries: 3,
                expected: ClaimDecision::Deliver { attempts: 1 },
            },
            Case {
                name: "last allowed retry",
                stored_attempts: 3,
                max_retries: 3,
                expected: ClaimDecision::Deliver { attempts: 4 },
            },
            Case {
                name: "ceiling crossed",
                stored_attempts: 4,
                max_retries: 3,
                expected: ClaimDecision::Drop { attempts: 5 },
            },
            Case {
                name: "zero retries still permits the first claim",
                stored_attempts: 0,
                max_retries: 0,
                expected: ClaimDecision::Deliver { attempts: 1 },
            },
            Case {
                name: "saturated counter remains droppable",
                stored_attempts: u16::MAX,
                max_retries: 100,
                expected: ClaimDecision::Drop { attempts: u16::MAX },
            },
        ];

        for case in cases {
            assert_eq!(
                claim_attempt(case.stored_attempts, case.max_retries),
                case.expected,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn delay_precedence_preserves_explicit_zero_and_clamps_the_selected_value() {
        struct Case {
            name: &'static str,
            per_message: Option<i64>,
            per_call: Option<i64>,
            configured: Option<i64>,
            expected: u32,
        }

        let cases = [
            Case {
                name: "no sources",
                per_message: None,
                per_call: None,
                configured: None,
                expected: 0,
            },
            Case {
                name: "configured default",
                per_message: None,
                per_call: None,
                configured: Some(17),
                expected: 17,
            },
            Case {
                name: "per call beats configured",
                per_message: None,
                per_call: Some(21),
                configured: Some(17),
                expected: 21,
            },
            Case {
                name: "per message beats per call",
                per_message: Some(31),
                per_call: Some(21),
                configured: Some(17),
                expected: 31,
            },
            Case {
                name: "message zero suppresses every default",
                per_message: Some(0),
                per_call: Some(21),
                configured: Some(17),
                expected: 0,
            },
            Case {
                name: "call zero suppresses configured default",
                per_message: None,
                per_call: Some(0),
                configured: Some(17),
                expected: 0,
            },
            Case {
                name: "negative explicit value clamps to zero",
                per_message: Some(-1),
                per_call: Some(21),
                configured: Some(17),
                expected: 0,
            },
            Case {
                name: "large explicit value clamps to one day",
                per_message: Some(i64::from(MAX_DELAY_SECONDS) + 1),
                per_call: Some(21),
                configured: Some(17),
                expected: MAX_DELAY_SECONDS,
            },
        ];

        for case in cases {
            assert_eq!(
                resolve_delay_seconds(case.per_message, case.per_call, case.configured),
                case.expected,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn visible_at_clamps_relative_delay_and_saturates_timestamp_arithmetic() {
        assert_eq!(visible_at_ms(1_000, -1), 1_000);
        assert_eq!(visible_at_ms(1_000, 0), 1_000);
        assert_eq!(visible_at_ms(1_000, 1), 2_000);
        assert_eq!(
            visible_at_ms(1_000, i64::from(MAX_DELAY_SECONDS) + 1),
            86_401_000
        );
        assert_eq!(visible_at_ms(i64::MAX - 1, 1), i64::MAX);
    }

    #[test]
    fn producer_and_retry_wrappers_use_the_same_precedence_seam() {
        let producer = ProducerConfig { delivery_delay: 19 };
        assert_eq!(producer_delay_seconds(None, None, &producer), 19);
        assert_eq!(producer_delay_seconds(None, Some(0), &producer), 0);
        assert_eq!(producer_delay_seconds(Some(7), Some(0), &producer), 7);

        let consumer = consumer_config();
        assert_eq!(retry_delay_seconds(None, None, &consumer), 12);
        assert_eq!(retry_delay_seconds(None, Some(0), &consumer), 0);
        assert_eq!(retry_delay_seconds(Some(7), Some(0), &consumer), 7);
        assert_eq!(retry_visible_at_ms(1_000, None, None, &consumer), 13_000);
    }

    #[test]
    fn defaults_resolve_to_the_manifest_values_and_each_bound_is_checked() {
        assert_eq!(
            resolve_producer(ProducerOptions::default()),
            Ok(ProducerConfig::default())
        );
        assert_eq!(
            resolve_consumer(ConsumerOptions::default()),
            Ok(ConsumerConfig::default())
        );

        assert_eq!(
            resolve_producer(ProducerOptions {
                delivery_delay: Some(42),
            }),
            Ok(ProducerConfig { delivery_delay: 42 })
        );
        assert_eq!(
            resolve_consumer(ConsumerOptions {
                max_batch_size: Some(100),
                max_batch_timeout: Some(60),
                max_retries: Some(100),
                retry_delay: Some(i64::from(MAX_DELAY_SECONDS)),
            }),
            Ok(ConsumerConfig {
                max_batch_size: 100,
                max_batch_timeout: 60,
                max_retries: 100,
                retry_delay: MAX_DELAY_SECONDS,
            })
        );

        let cases = [
            (
                ConfigField::DeliveryDelay,
                resolve_producer(ProducerOptions {
                    delivery_delay: Some(-1),
                })
                .map(|_| ()),
                -1,
                0,
                i64::from(MAX_DELAY_SECONDS),
            ),
            (
                ConfigField::DeliveryDelay,
                resolve_producer(ProducerOptions {
                    delivery_delay: Some(i64::from(MAX_DELAY_SECONDS) + 1),
                })
                .map(|_| ()),
                i64::from(MAX_DELAY_SECONDS) + 1,
                0,
                i64::from(MAX_DELAY_SECONDS),
            ),
            (
                ConfigField::MaxBatchSize,
                resolve_consumer(ConsumerOptions {
                    max_batch_size: Some(0),
                    ..ConsumerOptions::default()
                })
                .map(|_| ()),
                0,
                1,
                100,
            ),
            (
                ConfigField::MaxBatchTimeout,
                resolve_consumer(ConsumerOptions {
                    max_batch_timeout: Some(61),
                    ..ConsumerOptions::default()
                })
                .map(|_| ()),
                61,
                0,
                60,
            ),
            (
                ConfigField::MaxRetries,
                resolve_consumer(ConsumerOptions {
                    max_retries: Some(-1),
                    ..ConsumerOptions::default()
                })
                .map(|_| ()),
                -1,
                0,
                100,
            ),
            (
                ConfigField::RetryDelay,
                resolve_consumer(ConsumerOptions {
                    retry_delay: Some(i64::from(MAX_DELAY_SECONDS) + 1),
                    ..ConsumerOptions::default()
                })
                .map(|_| ()),
                i64::from(MAX_DELAY_SECONDS) + 1,
                0,
                i64::from(MAX_DELAY_SECONDS),
            ),
        ];

        for (field, result, value, min, max) in cases {
            assert_eq!(
                result,
                Err(ConfigError::OutOfRange {
                    field,
                    value,
                    min,
                    max,
                }),
                "{}",
                field.as_str()
            );
        }
    }

    #[test]
    fn queue_names_follow_the_cloudflare_ascii_contract() {
        let too_long = "a".repeat(MAX_QUEUE_NAME_LENGTH + 1);
        let cases = [
            ("", Err(QueueNameError::Empty)),
            ("alpha-1", Ok(())),
            ("a", Ok(())),
            ("a-b-c", Ok(())),
            (
                "-alpha",
                Err(QueueNameError::InvalidStart { character: '-' }),
            ),
            ("alpha-", Err(QueueNameError::InvalidEnd { character: '-' })),
            (
                "Alpha",
                Err(QueueNameError::InvalidCharacter { character: 'A' }),
            ),
            (
                "alpha.beta",
                Err(QueueNameError::InvalidCharacter { character: '.' }),
            ),
            (
                "alpha:beta",
                Err(QueueNameError::InvalidCharacter { character: ':' }),
            ),
            (
                "alpha$beta",
                Err(QueueNameError::InvalidCharacter { character: '$' }),
            ),
            (
                "é",
                Err(QueueNameError::InvalidCharacter { character: 'é' }),
            ),
        ];

        for (name, expected) in cases {
            assert_eq!(validate_name(name), expected, "{name:?}");
        }
        assert_eq!(
            validate_name(&too_long),
            Err(QueueNameError::TooLong {
                length: MAX_QUEUE_NAME_LENGTH + 1,
                max: MAX_QUEUE_NAME_LENGTH,
            })
        );
        assert_eq!(reserved_cell("alpha-1"), ".queue:alpha-1");
    }

    #[test]
    fn the_allowlist_models_supported_keys_and_rejects_every_pinned_gap() {
        for key in SUPPORTED_PRODUCER_KEYS {
            assert_eq!(
                config_key_verdict(QueueConfigSection::Producer, key),
                QueueKeyVerdict::Supported,
                "producer key {key}"
            );
        }
        for key in SUPPORTED_CONSUMER_KEYS {
            assert_eq!(
                config_key_verdict(QueueConfigSection::Consumer, key),
                QueueKeyVerdict::Supported,
                "consumer key {key}"
            );
        }

        let rejected = [
            ("dead_letter_queue", RejectedQueueKey::DeadLetterQueue),
            ("max_concurrency", RejectedQueueKey::MaxConcurrency),
            ("type", RejectedQueueKey::PullConsumerType),
            (
                "visibility_timeout_ms",
                RejectedQueueKey::PullVisibilityTimeout,
            ),
        ];
        for (key, reason) in rejected {
            assert_eq!(
                config_key_verdict(QueueConfigSection::Consumer, key),
                QueueKeyVerdict::Rejected(reason),
                "rejected key {key}"
            );
            assert!(matches!(
                validate_config_key(QueueConfigSection::Consumer, key),
                Err(QueueKeyError::Rejected { .. })
            ));
        }
        assert_eq!(
            config_key_verdict(QueueConfigSection::Consumer, "unknown"),
            QueueKeyVerdict::Unknown
        );
        assert_eq!(
            config_key_verdict(QueueConfigSection::Producer, "max_concurrency"),
            QueueKeyVerdict::Unknown
        );
    }
}
