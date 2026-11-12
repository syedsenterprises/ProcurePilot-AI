# ProcurePilot AI — Authentic UI Screenshot Inventory

This directory contains five authentic, un-mocked desktop screenshots of the ProcurePilot AI application running in an isolated local demonstration environment (`DATA_STORE_DIR=./.data-demo`).

---

## 📸 Screenshot Gallery & Operational Overview

| Filename | Resolution | File Size | Route / View | Core Capability Demonstrated |
| :--- | :--- | :--- | :--- | :--- |
| [`01-landing-page.png`](./01-landing-page.png) | 1280 × 800 px | 149.4 KB | `/` | Clean commercial SaaS landing page, value proposition & entry navigation (Next.js production workflow) |
| [`02-chat-copilot.png`](./02-chat-copilot.png) | 1440 × 1200 px | 272.4 KB | `/dashboard` (Procure Tab) | Component-focused heuristic copilot composition: unclipped panel header, consistent $5,000 budget, all 4 reasoning stages, complete equipment cards, $3,898 total, demo badge & excluded dashboard heading |
| [`03-spec-comparison.png`](./03-spec-comparison.png) | 1280 × 800 px | 280.9 KB | `/dashboard` (Catalogue Tab) | Multi-product architectural spec matrix with verified authentic imagery: Apple MacBook Pro 16" vs. Dell XPS 15 9530 |
| [`04-human-approval-gate.png`](./04-human-approval-gate.png) | 1280 × 800 px | 147.0 KB | `/dashboard` (Cart Drawer) | Mandatory cryptographic human governance gate & pre-signoff HMAC approval challenge |
| [`05-order-confirmation.png`](./05-order-confirmation.png) | 1440 × 1050 px | 184.8 KB | `/dashboard` (Checkout Handler) | Local simulation receipt with explicit simulation disclosure; not evidence of a PayPal gateway capture |
| [`06-genuine-paypal-sandbox-receipt-redacted.png`](./06-genuine-paypal-sandbox-receipt-redacted.png) | 1024 × 915 px | 228.8 KB | `/dashboard` (Receipt recovery) | Redacted UI evidence of a genuine PayPal Sandbox capture: COMPLETED status, itemization, 8.25% tax and $1,401.84 USD total; order, capture and approval identifiers removed |

---

## 🔍 Detailed View Breakdown

### 1. Landing Page (`01-landing-page.png`)
- **Route:** `http://localhost:3000/`
- **Resolution:** 1280 × 800 px
- **Status:** **Preserved unchanged** from verified baseline (SHA-256: `053abb37fc7dcf89e22c32b7ba2fc6b69cd527f13ce931835baea793b89b90e9`).
- **Capture Workflow:** Captured using the production server workflow (`next start`) to eliminate visible Next.js development/Turbopack indicators while strictly preserving authentic application rendering and layout.
- **Key Elements:**
  - **Header & Navigation:** ProcurePilot AI logo, feature links, and "Launch Procurement Console" CTA.
  - **Stage 1 Foundation Badge:** Displays "Stage 1 Foundation: Agentic Commerce & Guardrailed Procurement".
  - **Hero Value Proposition:** Highlights natural language requirement decomposition, server-side pricing reconciliation, and human authorization boundaries.
  - **Enterprise Architecture Cards:** Explains the 3 pillars of Zero-Trust Procurement: Heuristic & Live Gemini Reasoning, Server-Authoritative Pricing, and Dual-Mode PayPal Orders v2.

### 2. AI Procurement Copilot (`02-chat-copilot.png`)
- **Route:** `http://localhost:3000/dashboard` (Procure tab)
- **Resolution:** 1440 × 1200 px (Component-focused desktop composition)
- **Status:** **Updated production workflow capture** (SHA-256: `dca22a21185b79b33d43b56c9b2840d2a6b4de7aa3346863ae114822d31a9b49`).
- **Demonstrated Flow:** Requisition query *"I need an executive workstation setup within a $5,000 budget."*
- **Framing & Presentation:** Captured in an expanded 1440 × 1200 desktop viewport using the production server workflow (`next start`) to eliminate all Next.js development overlays. Scrolled past the dashboard top banner (`window.scrollTo(0, 125)`) to exclude the misleading "Production-Ready Architecture" heading while preserving the entire Agentic Procurement Copilot panel header completely unclipped. The bottom composer form is completely visible in the viewport and does not obscure any recommendations.
- **Consistent $5,000 Budget Alignment:** Concurrently reflects the $5,000 budget constraint across all four touchpoints:
  1. *User Requisition Prompt:* Shows *"I need an executive workstation setup within a $5,000 budget."*
  2. *Fiscal Budget Allocation Panel:* Accurately reflects Total Budget `$5,000` with Under Budget status.
  3. *Composer Budget Input:* Explicitly displays `5000` limit.
  4. *Reasoning Trace:* Step 1 verifies `$5000` constraint, and Step 4 reconciles against `$5000` ceiling.
- **Key Elements:**
  - **Transparent Engine Badge:** Clearly displays `Rule-Based Engine (Demo)` when `GEMINI_API_KEY` is empty, avoiding fabricated AI claims.
  - **Assistant Decomposed Text:** Introduces the tailored workstation proposal.
  - **4-Stage Reasoning Trace:** Visibly displays all four verified heuristic thought steps:
    1. *Requirement & Intent Analysis* (Parsing phase — extracted hardware categories and budget limit).
    2. *Catalogue Search & Stock Verification* (Retrieval phase — authoritative inventory scan).
    3. *Spec Comparison & Optimization* (Constraint solving phase — hardware compatibility matching).
    4. *Budget & Approval Check* (Synthesis phase — fiscal verification).
  - **Recommended Equipment Selection:** Displays the assembled product bundle:
    - *CalDigit TS4 Thunderbolt 4 Docking Station (18-in-1)* — $399.00 USD (90% Match)
    - *Apple MacBook Pro 16" (M3 Max, 36GB, 1TB)* — $3,499.00 USD (88% Match)
  - **Bundle Total Header:** Prominently displays `Bundle Total: $3,898 USD`.
  - **Bottom Composer Form:** Fully visible and uncovered in viewport, showing Budget Limit constraint ($5,000 USD), Natural Language prompt input, and "Generate Plan" action button.
  - **Auxiliary Dashboard Panels:** Shows the Fiscal Budget Tracker widget and Active Cart Queue in the right-hand layout column.

### 3. Specification Comparison Matrix (`03-spec-comparison.png`)
- **Route:** `http://localhost:3000/dashboard` (Product Catalogue tab)
- **Resolution:** 1280 × 800 px
- **Status:** **Updated with verified authentic product pair** (SHA-256: `68e65b9b58360bacfcd5120de8e110bfabbc24ccab8437075cbe827daa805d7a`).
- **Comparison Selection:** Two comparable flagship workstation laptops from the `Computing` category:
  1. *Apple MacBook Pro 16"* (M3 Max, 36GB, 1TB) — $3,499.00 USD
  2. *Dell XPS 15 9530* (i9-13900H, RTX 4070, 32GB) — $2,199.00 USD
- **Key Elements & Image Verification:**
  - **Verified Authentic Imagery:** Both products use existing, unedited catalogue imagery from `SAMPLE_PRODUCTS` in `src/services/catalog/products.data.ts`:
    - The Apple MacBook Pro 16" displays an authentic Apple MacBook Pro photograph (`photo-1517336714731-489689fd1ca8`).
    - The Dell XPS 15 9530 displays an authentic Dell XPS workstation photograph (`photo-1593642702821-c8da6771f0c6`).
  - **Resolution of Previous Defect:** Replaces the previous comparison pair where the Lenovo ThinkPad was shown with an inconsistent generic laptop image. Both displayed products now accurately and visibly match their brand and model.
  - **Multi-Product Architectural Matrix Modal:** Renders side-by-side technical comparisons across processor architecture, memory bandwidth, graphics capabilities, display panels (Liquid Retina XDR vs. 3.5K OLED InfinityEdge), and ports.

### 4. Mandatory Human Governance Gate (`04-human-approval-gate.png`)
- **Route:** `http://localhost:3000/dashboard` (Triggered via Cart Drawer)
- **Resolution:** 1280 × 800 px
- **Status:** **Preserved unchanged** from verified baseline (SHA-256: `2225a61bdb5c2c7be55fec58741cb4b532fe90fc8935a23c6f49c9d70a659fc1`).
- **Pre-Signoff State & Identity Disclosure:**
  - **Pre-Signoff Challenge:** This view captures the active **pre-signoff challenge state** prior to cryptographic signature submission.
  - **Demonstration Attestation:** The pre-populated approver identity (`Alex Mercer (Procurement Lead)`) is **self-attested demonstration data** entered by the evaluator in this local UI.
  - **Identity Boundary:** This does **not** represent an authenticated enterprise Single Sign-On (SSO) or IdP identity; Stage 2 relies on cryptographic HMAC tickets and explicit checkbox sign-off.
- **Key Elements:**
  - **Zero Autonomous Execution Boundary:** AI agents are cryptographically blocked from placing orders without human authorization.
  - **Requisition Audit Summary:** Itemized breakdown of approved equipment and verified total ($4,219.59 USD).
  - **Attestation Fields:** Requires Approver Name, Department (`Engineering & DevOps`), and Business Justification.
  - **HMAC-SHA256 Challenge Binding:** Binds the order to an immutable challenge ticket and exact cart fingerprint.

### 5. Order Confirmation & Simulated Capture (`05-order-confirmation.png`)
- **Route:** `http://localhost:3000/dashboard?status=approved&token=SANDBOX_STAGE2_179426792473`
- **Resolution:** 1440 × 1050 px (Zero-clipping complete modal capture)
- **Status:** **Updated production workflow capture** (SHA-256: `96607f73603d984ab9dce6f60e6499f9e722b905686bef59078636bcea8112dd`).
- **Capture Workflow:** Captured using the production server workflow (`next start`), completely eliminating all development overlays and "Compiling..." indicators while idempotently reusing the existing demonstration record (`SANDBOX_STAGE2_179426792473`) with zero new records created.
- **Framing & Viewport Presentation:** The modal is 890 px tall and fits entirely within the 1050 px viewport (`isScrollable: false`). There are zero internal vertical scrollbars and zero clipped sections from header to footer.
- **Simulation Capture Disclosure:**
  - **Local Simulation:** Captured with `ALLOW_PAYPAL_SIMULATION=true`. The order was processed entirely by the local offline simulation engine in `src/services/paypal/paypal.service.ts`.
  - **Locally Generated Capture ID:** The capture transaction identifier (`CAP_SANDBOX_STAGE2_179426792473`) is generated locally (`CAP_${orderId}`) by simulation code.
  - **No Real PayPal Financial Capture:** No external network request was sent to PayPal servers, and no live financial funds were debited.
- **Exact Identifiers & Status:**
  - *Order Status:* `COMPLETED` (green badge in modal; underlying order record status is `CAPTURED`)
  - *PayPal Order ID:* `SANDBOX_STAGE2_179426792473`
  - *Capture Transaction ID:* `CAP_SANDBOX_STAGE2_179426792473`
  - *Cryptographic Ticket ID:* `appr_tk_1794267924735_7daf34ba74089225`
- **Key Elements:**
  - **Commercial Purchase Order Confirmation Header:** Displays title, subtitle, and top "Print Receipt" button.
  - **Prominent Amber Simulation Notice:** Clearly discloses development simulation mode and lack of live PayPal fund movement.
  - **Reference Identifiers Grid:** Displays Order ID, Capture ID, Payment Status badge, and transaction date.
  - **Authoritative Itemized Inventory Table:** Itemized rows for CalDigit TS4 Docking Station and Apple MacBook Pro 16" with unit prices and line totals.
  - **Pricing Breakdown:** Subtotal ($3,898.00), Sales Tax ($321.59), Shipping (FREE), Total Paid & Captured ($4,219.59 USD).
  - **Governance Sign-Off & Ticket Provenance Stamp:** Shows Requisitioner (`Alex Mercer`), Department (`Engineering & DevOps`), and Cryptographic Ticket ID (`appr_tk_1794267924735_7daf34ba74089225`).
  - **Footer Actions:** Audit registry archival notice, secondary "Print Receipt" button, and "Done" button.

---

### 6. Genuine PayPal Sandbox Receipt (Redacted)
- **Source:** Browser acceptance evidence captured on November 11, 2026 after an independently queried PayPal Sandbox Orders v2 order and completed capture.
- **Displayed evidence:** `COMPLETED` status, Herman Miller Aeron line item, $1,295.00 subtotal, $106.84 tax and $1,401.84 USD total.
- **Privacy:** PayPal order ID, capture transaction ID and HMAC approval ticket identifier are redacted in this public screenshot. The original unredacted evidence remains private and is not included in the repository.
- **Boundary:** This is PayPal Sandbox test evidence, not a live-money or production transaction.

## 🛡️ Isolation & Reproducibility Guarantees
- **Screenshots 01–05:** Captured in an isolated local demonstration using `DATA_STORE_DIR=./.data-demo`; local simulation records were written to `.data-demo/`.
- **Baseline preservation for screenshots 01–05:** The 81 historical orders and 219 approvals in `.data/` were verified byte-for-byte identical before and after that local screenshot run.
- **Network boundary:** Screenshots 01–05 used the local heuristic/simulation path without Gemini or PayPal network calls. Screenshot 06 is separate evidence from a genuine PayPal Sandbox transaction and necessarily involved PayPal Sandbox API communication.
