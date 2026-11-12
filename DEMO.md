# ProcurePilot AI — Evaluator Demonstration Guide

**Document Purpose:** Step-by-step evaluator guide to demonstrate ProcurePilot AI's agentic procurement workflow, zero-trust governance safeguards, and automated security suites in a safe local environment.  
**Repository:** ProcurePilot AI (Root Directory)  
**Target Audience:** PayPal AI Hackathon evaluators, architects, and technical reviewers.

## Hackathon Demo — Current Hosted Build

- **Hosted application:** https://procurepilot-ai-1mcw.onrender.com/
- **Procurement console:** https://procurepilot-ai-1mcw.onrender.com/dashboard
- **Source repository:** https://github.com/syedsenterprises/ProcurePilot-AI
- **Verified on November 12, 2026:** hosted homepage and dashboard returned HTTP 200; `/api/catalog` returned 14 products; a live `/api/procure` request confirmed `provider: gemini-api` and `aiStatus: live`. That test exposed a total-budget reconciliation gap in model recommendations. The current source now checks every candidate against authoritative stock, quantity, tax, shipping and the full budget before returning it; regression coverage verifies rejection of an over-budget candidate.
- **PayPal boundary:** The application uses PayPal Orders v2 in Sandbox when sandbox credentials are configured. A genuine Sandbox order and capture were independently verified on November 11, 2026 for $1,401.84 USD. A redacted receipt screenshot is included as `docs/screenshots/06-genuine-paypal-sandbox-receipt-redacted.png`. Do not create another payment solely to reproduce the evidence.
- **Disclosure:** Sandbox funds are test funds. The application is a single-tenant hackathon prototype; runtime order state is file-backed, PostgreSQL migrations were validated separately, and the approver identity is self-attested demo data rather than enterprise SSO.

---

## 🧭 Executive Overview of Capabilities

ProcurePilot AI demonstrates an end-to-end B2B equipment procurement copilot that solves the fundamental conflict between conversational AI autonomy and corporate commercial governance:
1. **Conversational Requisitioning:** Users state requirements in natural language with optional budget constraints.
2. **Transparent Dual-Mode Reasoning:** Runs either via Google Gemini API (`gemini-flash-latest`) with tool function calling or via an offline, transparent Heuristic Rules Engine if no API key is present.
3. **Zero-Trust Pricing Reconciliation:** Client-submitted prices and totals are strictly ignored; all line totals, taxes, shipping fees, and budget caps are authoritatively computed server-side from the verified catalogue.
4. **Mandatory Human Governance Gate:** AI agents are cryptographically blocked from autonomously placing orders. A human officer must sign an HMAC-SHA256 challenge bound to the exact cart fingerprint and session token.
5. **Simulated / Live PayPal Orders v2 Checkout:** Supports live PayPal sandbox checkout or safe, isolated sandbox simulation.

---

## ⚙️ Prerequisites & Minimal Environment Setup

### 1. Prerequisites
- **Node.js:** v18.18+ or v20+ (tested on Node v26.11)
- **Web Browser:** Modern browser (Chrome, Edge, Firefox, Safari)
- **PostgreSQL:** *Optional* for UI and checkout demonstration; only required if running live database test suites (`npm run test:db`).

### 2. Environment Configuration

To run a safe local demonstration, create `.env.local` from the template:

```bash
cp .env.example .env.local
```

Populate `.env.local` with the following **recommended demo settings**:

```env
# ----------------------------------------------------------------------
# 1. Google Gemini AI (OPTIONAL)
# If left empty, ProcurePilot runs in zero-credential Heuristic Mode
# ----------------------------------------------------------------------
GEMINI_API_KEY=
GEMINI_MODEL=gemini-flash-latest

# ----------------------------------------------------------------------
# 2. Approval HMAC Secret (REQUIRED FOR APPROVAL GATE)
# Must be non-empty for cryptographic signing. Any secure string works.
# ----------------------------------------------------------------------
APPROVAL_SECRET=<generate-a-private-64-character-hex-secret>

# ----------------------------------------------------------------------
# 3. PayPal Sandbox (OPTIONAL FOR DEMO)
# Leave credentials blank and enable simulation for safe zero-cost demo.
# ----------------------------------------------------------------------
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_ENVIRONMENT=sandbox
ALLOW_PAYPAL_SIMULATION=true

# ----------------------------------------------------------------------
# 4. App URL
# ----------------------------------------------------------------------
NEXT_PUBLIC_APP_URL=http://localhost:3000

# ----------------------------------------------------------------------
# 5. Data Store Isolation (RECOMMENDED FOR NON-DESTRUCTIVE DEMO)
# Points new demo orders/approvals to an isolated temporary directory
# ensuring the 81 historical baseline files in .data/ are never touched.
# ----------------------------------------------------------------------
DATA_STORE_DIR=./.data-demo
```

> **Why `DATA_STORE_DIR` is Recommended:**  
> In default operation, simulated orders and approval tickets write to `.data/orders` and `.data/approvals`. Setting `DATA_STORE_DIR=./.data-demo` directs all new runtime writes into an isolated folder, preserving the 81 baseline orders and 219 historical tickets intact.

> [!WARNING]
> **Secret handling:** Generate a fresh secret for every environment with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it in the uncommitted `.env.local`; never paste it into source control, screenshots, chat, or the Devpost submission. Do not reuse a public example value.

---

## 🚀 Step-by-Step Evaluator Walkthrough

### Step 1: Install & Launch Application

In your terminal:

```bash
# 1. Install dependencies
npm install

# 2. Start Next.js development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

- **Landing Page (`/`):** View the SaaS overview, commercial governance principles, and product catalogue highlights.
- **Click "Launch Procurement Console"** or navigate directly to `http://localhost:3000/dashboard`.

---

### Step 2: Natural Language Requisition & Heuristic Copilot

1. On the **AI Procurement Copilot** tab, inspect the interface.
2. Notice the **Quick Procurement Scenario Presets** above the prompt box:
   - *Software Engineer Station* ($6,000 budget cap)
   - *Ergonomic Workspace Revamp* ($2,000 budget cap)
   - *Executive Video & Podcast Studio* ($2,500 budget cap)
   - *Startup Office Infrastructure* ($1,500 budget cap)
3. Click the preset **"Ergonomic Workspace Revamp"** (or type: `"I need an ergonomic standing desk and an active lumbar chair under $2,000"`).
4. Click **"Analyze & Assemble Package"**.
5. **Expected Results:**
   - **Reasoning Feed:** The copilot displays a 4-stage reasoning breakdown:
     - *Step 1: Requirement & Intent Analysis* (extracted categories: Furniture, budget: $2,000).
     - *Step 2: Catalogue Search & Stock Verification* (scanned 14 verified products).
     - *Step 3: Spec Comparison & Optimization* (matched Jarvis Standing Desk + Herman Miller Aeron or Steelcase Gesture).
     - *Step 4: Budget & Approval Check* (verified total fits within $2,000 cap).
   - **Transparency Badge:** Because no `GEMINI_API_KEY` was configured, the response clearly displays:
     `Heuristic Rule Engine (Transparent Fallback)` and indicates running in transparent rule-based mode (no fake AI claims).
   - **Recommended Bundle:** Structured product cards appear with match scores, unit prices, and justifications.

---

### Step 3: Multi-Specification Product Comparison

1. Switch to the **Product Catalogue** tab in the top navigation bar.
2. Filter by Category (e.g. *Displays* or *Computing*).
3. Check the **"Compare"** checkbox on two competing items (e.g., *Dell UltraSharp 32" 6K Monitor* vs *Apple Studio Display 27"*).
4. Click **"Compare Selected (2)"** at the bottom right.
5. **Expected Results:**
   - A modal displays a side-by-side comparison of display technology, resolution, ports, power delivery, warranty, and pricing to justify enterprise selection.

---

### Step 4: Cart Assembly & Server-Side Price Reconciliation

1. Switch back to the **Procure** tab and click **"Add All to Cart"** on the recommended package.
2. Open the **Cart Drawer** (via the shopping bag icon in the navbar).
3. **Observe Commercial Calculations:**
   - Subtotal, Sales Tax (8.25% standard), and Shipping are calculated.
   - **Fiscal Budget Bar:** Shows remaining headroom against the detected budget limit.
4. **Zero-Trust Verification Note:**  
   If an adversary attempts to modify the payload sent to `/api/cart/validate`, the server-side `CatalogService` strictly ignores client prices and recalculates every line item directly from authoritative server memory.

---

### Step 5: Mandatory Human Governance Gate Signoff

1. Inside the Cart Drawer, click **"Proceed to Human Signoff"**.
2. The **Human Authorization Gate** modal opens.
3. Review the **Requisition Audit Summary**:
   - Itemized product breakdown.
   - Verified total bound to the authorization challenge.
4. Fill out the required signoff fields:
   - **Approver Name:** `Alex Mercer`
   - **Department:** `Engineering`
   - **Business Justification:** `Q1 ergonomic refresh for senior full-stack engineer`
5. Check the confirmation checkbox: *"I confirm that this requisition complies with corporate purchasing policy..."*
6. Click **"Sign & Authorize Requisition"**.
7. **Expected Results:**
   - `/api/approval/challenge` generates an HMAC-SHA256 challenge bound to the cart fingerprint and session token.
   - `/api/approval/sign` verifies the challenge and signs a single-use authorization token (`appr_tk_*`).
   - A success banner confirms: *"Requisition Digitally Signed by Alex Mercer — Ticket valid for 10 minutes"*.

---

### Step 6: Simulated PayPal Orders v2 Server Checkout

1. Click **"Proceed to Payment Authorization"**.
2. The system submits the signed ticket ID and auth token to `/api/paypal/create-order`.
3. **Expected Results:**
   - The server verifies that the ticket is unconsumed, matches the current cart, and has not expired.
   - Because `ALLOW_PAYPAL_SIMULATION=true` is set, the server generates a simulated order (`SANDBOX_STAGE2_*`).
   - **Simulation Banner:** The interface displays a clear warning:
     `DEVELOPMENT/TEST SIMULATION: This is an unauthenticated mock order for testing purposes. No real or sandbox funds were authorized.`
   - The approval ticket is permanently marked as `CONSUMED` in storage. Any replay attempt with the same ticket is rejected fail-closed.

---

### Step 7: Anti-Tampering & Security Demonstration

To observe how ProcurePilot AI blocks adversarial tampering:

1. **Attempting Ticket Replay:**
   - If a client attempts to submit the same `ticketId` again, `/api/paypal/create-order` responds with:
     `Security Error: Approval ticket has already been consumed.`
2. **Attempting Missing HMAC Secret:**
   - If `APPROVAL_SECRET` is unset in `.env.local`, any attempt to generate a challenge at `/api/approval/challenge` throws an explicit configuration error and returns HTTP 500 without generating an insecure token.
3. **Cart Tampering:**
   - If line item quantities or product IDs are modified after the ticket was signed, the server detects a cart fingerprint mismatch and rejects the checkout.

---

## 🧪 Automated Test Verification

Evaluators can verify the complete security and integrity foundation directly via automated CLI test runners:

### 1. Full Automated Security & Lifecycle Suite
```bash
npm test
```
- **What it verifies:** 8 core domains including approval anti-tampering, Gemini retry/fallback logic, webhook signatures, schema contracts, decimal parsing, and refund headroom locking.
- **Expected result:** `🎉 ALL AUTOMATED SECURITY & CHECKOUT LIFECYCLE TESTS PASSED (0 FAILURES)`.

### 2. Approval Security & Anti-Tampering Suite
```bash
npx tsx tests/security/approval.test.ts
```
- **What it verifies:** 15 focused security tests covering HMAC integrity, cart tampering, quantity manipulation, 10-minute TTL expiration, cross-session CSRF protection, and fail-closed secret encapsulation.
- **Expected result:** `✅ ALL APPROVAL SECURITY TESTS PASSED (15/15)`.

### 3. Delta Reconciliation & Immutability Suite
```bash
npx tsx tests/db/delta-reconciliation.test.ts
```
*(Requires a running local PostgreSQL instance on port 5432 with standard postgres user)*
- **What it verifies:** 47 tests covering procedural environment guards, state-bound signature verification, stored procedure overload resolution, audit immutability triggers, and flatfile capture de-authorization.
- **Expected result:** `🎉 ALL DELTA RECONCILIATION PHASE B.4.2.2 SECURITY TESTS PASSED (0 FAILURES)`.

---

## 🧹 Post-Demo Cleanup Guidance

1. **If using `DATA_STORE_DIR=./.data-demo`:**
   Remove only the isolated demo data directory:
   - **Bash / Linux / macOS:**
     ```bash
     rm -rf ./.data-demo
     ```
   - **Windows PowerShell:**
     ```powershell
     Remove-Item -LiteralPath .\.data-demo -Recurse -Force
     ```
   > **Safety Note:** This command removes *only* the temporary `./.data-demo` directory created during the demo. Do not run any command targeting `.data/`, which contains the authoritative baseline records.

2. **Verifying Protected Inventory:**
   Ensure the authoritative repository baseline remains 100% untouched:
   ```bash
   git status --short
   ```
   The persistent `.data/` directory must contain exactly 81 orders and 219 approvals.

---

## ⚠️ Important Architectural Boundaries & Disclosures

To ensure strict evaluative accuracy, evaluators should note the following system boundaries:

- **Authoritative Runtime:** The active application runtime currently operates against the file-backed JSON store (`.data/`).
- **PostgreSQL Persistence Status:** Relational migrations (001–008), schema constraints, and delta reconciliation have been validated in isolated test environments. **No production database cutover has occurred.**
- **Legacy Approvals:** The 219 historical approval tickets in `.data/approvals` were generated before runtime session token binding and are classified as `UNVERIFIABLE_LEGACY`. They serve as historical audit records and cannot authorize new runtime checkouts.
- **Payment Captures:** 78 of the 79 legacy capture records are synthetic test stubs (`isSimulated: true`) and are excluded from the PostgreSQL financial ledger. Only 1 record is a genuine PayPal capture ($294.54 USD).
- **Human Identity:** Enterprise SSO (OIDC/SAML) is not yet integrated. Human signoff uses self-attested identity (`SELF_ATTESTED_REQUISITIONER`).
- **Environment Guards:** Checks in `assertDatabaseSafety()` are procedural code guards designed to prevent accidental development runs against production; they do not constitute hardware attestation.
