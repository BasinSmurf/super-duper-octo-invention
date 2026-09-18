# PCI scope — how ServicePRO takes card payments

**Status:** a finding, and a decision recorded. Raised while building WI-08
(paid-at-drop, 2026-08-31); the decision to stay on Stripe Elements was Max's.

WI-08 asked us to *"confirm the existing checkout is a hosted Stripe flow"*.
**It is not.** This document says what it actually is, why the underlying safety
requirement is nevertheless met, and what the choice costs — so the next person
to ask does not have to re-derive it from the source.

---

## What is actually implemented

**Stripe Elements**, not Stripe Checkout.

- `client/src/components/PaymentForm.tsx` renders `<CardElement>` from
  `@stripe/react-stripe-js` and calls `stripe.confirmCardPayment(clientSecret, …)`.
- `server/src/routes/payments.ts` creates a PaymentIntent server-side and returns
  only the `clientSecret`. The publishable key is served from `/api/payments/config`.
- The secret key lives in `STRIPE_SECRET_KEY` and never leaves the server.

`CardElement` is an **iframe served by Stripe** (`js.stripe.com`, allowed
explicitly in the CSP in `server/src/index.ts`). The customer types their card
number into Stripe's document, inside a page Basin serves.

## The requirement WI-08 actually cares about IS met

> *"Card data must not transit or rest on BSCC devices or servers."*

It does not. The card number goes from the browser **directly to Stripe's API**
from inside Stripe's own iframe. It is never posted to a Basin endpoint, never
appears in a request body Basin handles, and is never written to a Basin
database or log. What comes back to us is a PaymentIntent id, a charge id, a
brand and the last four digits — `payments.card_last4` / `card_brand` — which are
not cardholder data under PCI DSS.

**No card data is persisted anywhere in Sundog.** That WI-08 acceptance criterion
holds, and it is the one that matters operationally.

## What differs: the self-assessment tier

Elements and Checkout land in different SAQ categories:

| | Where the card is typed | SAQ |
|---|---|---|
| **Stripe Checkout** (redirect) | a page served by `stripe.com` | **A** |
| **Stripe Elements** (iframe) — *what we run* | Stripe's iframe, in a Basin-served page | **A-EP** |

SAQ **A** applies when the merchant's site does not serve the payment page at
all. Because Basin serves the page that *hosts* the iframe, that page can in
principle be altered to affect the payment — so it is in scope, and the tier is
**A-EP**.

Practically, A-EP adds obligations that A does not have, including:

- quarterly ASV (Approved Scanning Vendor) scans of the public-facing site
- change control and integrity monitoring on the payment page and its scripts
- a longer self-assessment questionnaire

None of this changes what the software does. It changes what Basin has to attest
to and evidence.

## The decision

**Stay on Elements. Accept SAQ A-EP.** (Max, 2026-08-31.)

Reasoning, recorded so it is not re-litigated from scratch:

- The safety property — card data never touching Basin systems — is already
  satisfied. The difference is paperwork tier, not exposure.
- Moving to Checkout means a redirect off the app mid-flow. At a shop intake
  counter with a customer waiting and a tech on an iPad, leaving the app and
  coming back is materially worse than the embedded form, and is exactly the
  moment WI-08 is trying to make faster.
- It would also mean rebuilding `PaymentForm` and all three call sites
  (`TicketDetailPage`, `ShopOrderDetailPage`, `DirectSalePage`).

**If the ASV-scan obligation turns out to be unwelcome**, switching to Checkout is
a contained change — `PaymentForm` is the only component that touches
`CardElement`, and the server side (PaymentIntents, the webhook, the QB receipt
queue) is identical either way. That is worth knowing: the decision is
reversible without touching the accounting path.

## Where to look if this is revisited

| Concern | File |
|---|---|
| Card entry component | `client/src/components/PaymentForm.tsx` |
| PaymentIntent creation, publishable key | `server/src/routes/payments.ts` |
| Stripe SDK config, secret key | `server/src/services/stripeClient.ts` |
| CSP allowing `js.stripe.com` / `hooks.stripe.com` | `server/src/index.ts` |
| Webhook signature verification | `server/src/services/stripeWebhook.ts` |
| What we store about a card | `Payment` model — `card_last4`, `card_brand` only |

## Not covered here

Lightspeed. The in-store POS handles its own card acceptance entirely outside
ServicePRO; WI-08 records only a transaction reference number so the manual
QuickBooks entry is reconcilable. No card data, and no PCI surface, reaches this
system from that path.
