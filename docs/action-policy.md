# Resolve action in this order. The first rule that applies wins

1. Deception, credential requests, or coerced payment through a sender-controlled
   channel: mute. Overrides all engagement history and sender familiarity.
2. Direct address to the recipient (@mention, named, or 1:1) requiring a response,
   with a same-day consequence: notify. Overrides group mute and quiet hours.
3. Transactional status on something the recipient actively has open (order,
   booking, statement, appointment, escalation): notify.
4. Scheduled information the recipient needs before a stated deadline: notify if
   the deadline is today, digest otherwise.
5. Content from a sender the recipient has opted out of, repeatedly dismissed,
   or never engaged with: mute.
6. Everything else safe and useful: digest.

Digest is the default, not a fallback for uncertainty. Uncertainty about the type
never changes the action.
