# Useful for determining the type of a message. The first rule that applies wins

1. Does it seek credentials, or route money through a channel the sender controls,
   or offer an unsolicited windfall requiring action? -> scam
2. Is it unsolicited commercial content from a sender with no legitimate
   relationship to the recipient? -> spam
   (Marketing from a verified brand the recipient knows is promotion even when
   muted. Legitimacy of the sender decides spam vs promotion, not the content.)
3. Is the sender relationship unestablished and unverifiable? -> unknown
   This overrides the topical type.
4. Does it state a real payment obligation or a real transaction on the
   recipient's account? -> payment
5. Is it selling or offering something? -> promotion
   Peer-to-peer resale in a group is promotion, not personal.
6. Does it demand action from the recipient within hours with a stated
   consequence? -> urgent
   A scheduled happening is event even when imminent. Urgent requires a demand
   on this recipient, not just a short timeline.
7. Is it directed at the recipient personally? -> personal
   A direct mention about event logistics is personal, not event.
8. Is it about a scheduled happening, its logistics, or a change to it? -> event
9. Is it a transactional or service communication from a business about an
   existing relationship? -> business_update
   Feedback requests and advisories are business_update, not promotion.
10. Is its primary purpose a well-wish? -> greeting
    Forwarding does not change this. forwarded_count is not a type signal.
11. Is it impersonal chain content with no other primary purpose? -> forward
12. Otherwise -> unknown
