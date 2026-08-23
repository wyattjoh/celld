# Queue delivery

This context names the Cloudflare-compatible producer and push-consumer model that celld implements as durable queue delivery.

## Language

**Queue**:
A named backlog of messages delivered at least once to a consumer. A queue name is fleet-global, so producer and consumer bindings refer to the same logical backlog.
_Avoid_: topic, channel

**Producer binding**:
A Worker or Durable Object environment binding that appends messages to a queue and receives a durable acknowledgement.
_Avoid_: sender, publisher

**Consumer**:
A push handler that receives a batch of queue messages and explicitly acknowledges or retries them.
_Avoid_: subscriber, worker

**Queue cell**:
The reserved Durable Object that owns one queue's backlog and delivery lifecycle. Its identity is `.queue:<name>`.
_Avoid_: queue worker, broker

**Delivery attempt**:
One claim of a message for a consumer invocation, counted before the handler runs so a crashed handler still consumes retry budget.
_Avoid_: retry count

**Visible time**:
The earliest timestamp at which a queued message may be claimed for delivery.
_Avoid_: due date, deadline
