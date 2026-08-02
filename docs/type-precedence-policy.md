# Classification and type precedence

## Classification order

1. Determine `message_type` from the target message's primary communicative purpose.
2. Determine `action` independently using the target message plus relevant history.
3. Do not infer action mechanically from `message_type`:
   - urgent does not always mean notify,
   - spam does not always mean mute,
   - payment does not always mean notify.
4. History may change action, but changes `message_type` only when it clarifies the
   target message's purpose, legitimacy, or risk.

## Type precedence

Choose the first applicable type.

1. **scam** — Meaningful evidence of deception, impersonation, credential theft,
   financial theft, or an unsafe verification/payment flow.
2. **urgent** — An active emergency, safety incident, critical operational failure,
   or immediate request where delay could cause serious harm. Time sensitivity alone
   is insufficient.
3. **payment** — A legitimate financial transaction, obligation, or money-movement
   status in which the recipient is a participant: bills, transfers, receipts,
   refunds, reimbursements, payment failures, or amounts due.
4. **event** — Timing, attendance, appointments, meetings, travel, schedules,
   locations, or event logistics.
5. **business_update** — A legitimate order, account, delivery, support, service, or
   operational status not primarily about payment or an event.
6. **promotion** — A recognizable legitimate offer, sale, commercial invitation,
   listing, or marketing message.
7. **spam** — Generic, unsolicited, bulk, repetitive, or low-quality solicitation
   without meaningful deception.
8. **greeting** — Greeting, blessing, pleasantry, or good wishes without substantive
   content.
9. **personal** — Ordinary interpersonal conversation, question, request, or update
   where no more specific type applies.
10. **forward** — Generic information, advice, or chain content passed along when no
    more specific purpose applies. Forwarded content retains an identifiable primary
    type.
11. **unknown** — Use only when the meaning or relationship remains materially
    ambiguous after considering every other type.

## Type rules

- Scam overrides every other type.
- A legitimate payment remains payment even when time-sensitive; action carries its
  interruption priority.
- An active payment-system outage is urgent, not payment.
- A discount conditional on paying is promotion, not payment.
- A legitimate unwanted offer remains promotion; unwantedness affects action.
- A forwarded greeting, event, or scam remains greeting, event, or scam.
- An unfamiliar sender alone does not produce unknown, spam, or scam.
