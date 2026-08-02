# Action decision tree

Evaluate in this order:

1. **Mute** when there is positive evidence that the message is:
   - deceptive or unsafe,
   - generic unsolicited spam,
   - explicitly unwanted,
   - repeatedly dismissed or reported,
   - or repetitive low-value content from the same source.

   Do not mute merely because the sender is unfamiliar, the message is promotional,
   or the content is low priority.

2. **Notify** when the legitimate message has at least one concrete interruption reason:
   - an active emergency or safety issue,
   - a direct question or request requiring a near-term response,
   - a deadline or consequence that will occur soon if the user does not act,
   - a material change to an imminent event, payment, delivery, or appointment,
   - or a strongly awaited important update established by history.

   Promotional scarcity and words such as "urgent" are not sufficient.

3. **Digest** everything else that is legitimate, safe, and deferrable.

## Tie-breakers

- Uncertain between notify and digest: digest.
- Uncertain between digest and mute: digest.
- Explicit risk evidence: mute.
- Explicit immediate consequence: notify.
- User preference or conversation history must be supported by supplied evidence.
- A muted source may still notify for a genuine emergency or critical direct request.
