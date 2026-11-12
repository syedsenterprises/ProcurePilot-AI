# ProcurePilot AI — Enterprise Equipment Procurement & Commerce Governance

> **Agentic B2B Equipment Procurement & Guardrailed Autonomous Commerce**  
> Built with Next.js App Router, TypeScript, Tailwind CSS, and an Authoritative Relational Persistence Foundation.

---

## 📌 Product Objective

**ProcurePilot AI** is an intelligent procurement copilot designed for freelancers, high-growth startups, and small-to-medium businesses. It bridges the gap between conversational AI discovery and strict corporate financial governance.

Users describe what equipment they need in plain English, specify target budgets, and receive structured, constraint-optimized hardware packages selected from a verified enterprise catalogue.

### PayPal AI Hackathon — Working Demo & Verified Integration

- **Hosted demo:** https://procurepilot-ai-1mcw.onrender.com/dashboard
- **Public source:** https://github.com/syedsenterprises/ProcurePilot-AI (MIT License)
- **AI:** Google Gemini API with server-side catalogue tools. The live hosted endpoint was verified on November 12, 2026; it returned four budget-constrained recommendations and executed catalogue search and budget-validation tool calls.
- **PayPal:** PayPal Orders v2 Sandbox checkout is integrated server-side. A genuine Sandbox payment capture for **$1,401.84 USD** was independently checked against the PayPal Sandbox Orders API on November 11, 2026. A public receipt screenshot is available in `docs/screenshots/06-genuine-paypal-sandbox-receipt-redacted.png`; transaction identifiers are redacted.
- **Runtime disclosure:** This is a single-tenant hackathon prototype. Runtime order persistence remains file-backed; PostgreSQL migrations and reconciliation were validated separately, not cut over. Approver identity is self-attested demo data, not enterprise SSO. Sandbox funds are not real money.

### The 8-Stage Procurement Workflow

```
[1. Natural Language RFQ]
           │
           ▼
[2. AI Discovery & Requirement Decomposition]
           │
           ▼
[3. Multi-Specification Product Comparison]
           │
           ▼
[4. Intelligent Reconciled Cart Assembly]
           │
           ▼
[5. Authoritative Server-Side Budget Validation]
           │
           ▼
[6. Mandatory Human Governance Sign-Off]
           │
           ▼
[7. PayPal Sandbox Orders v2 Server Checkout]
           │
           ▼
[8. Purchase Confirmation & Audit Receipt]
```

---

## 🛡️ Security & Commercial Governance Safeguards

ProcurePilot AI is built on **Zero-Trust Commercial Principles**:

1. **Zero Client-Submitted Pricing Trust:** Product prices and calculations submitted in client payloads are strictly ignored. All line totals, sales taxes, shipping rates, and budget allocations are computed authoritatively on the server by `CatalogService`.
2. **No Autonomous AI Execution:** AI agents are never permitted to execute transactions or checkout automatically. A dedicated **Human Authorization Gate** (`HumanApprovalGate`) enforces mandatory officer signoff (name, department, business justification, and digital HMAC challenge signing) prior to order generation.
3. **Cryptographic Approval Token Lifecycle:** Requisition approvals are signed using HMAC-SHA256, bound to cart fingerprints, session tokens, and strict 10-minute expiry TTLs. All signing keys fail closed if unconfigured.
4. **Strict Server-Side Payment Operations:** PayPal client IDs, secrets, bearer tokens, and order creation calls remain strictly inside server-side Next.js API routes (`/api/paypal/create-order`). Client components never access payment credentials.
5. **Dual-Mode AI Transparency:** Includes both a live Google Gemini API connector (`gemini-flash-latest`) with tool function calling and an offline, transparent Heuristic Rules Engine. If `GEMINI_API_KEY` is not detected, the system transparently indicates that the rule-based engine is active rather than faking an AI connection.

---

## 🚀 Technology Stack

- **Framework:** [Next.js](https://nextjs.org/) (App Router, Turbopack, React 19)
- **Language:** [TypeScript](https://www.typescriptlang.org/) (Strict typing across products, cart, procurement, PayPal, and database contracts)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/) (Deep navy `#020617` and subtle purple/indigo accents)
- **Database Engine:** [PostgreSQL](https://www.postgresql.org/) (14+ with strict relational constraints, append-only ledgers, and row-level locks)
- **Database Client:** `pg` (Node-Postgres with connection pooling)
- **Validation:** [Zod](https://zod.dev/) (Runtime schema parsing and input sanitization)
- **Icons:** [Lucide React](https://lucide.dev/)
- **Linting & Formatting:** ESLint (Flat Config)
- **Integrations Architecture:**
  - Google Gemini API (`@/services/gemini`) with function calling and multi-model fallback
  - PayPal Orders v2 API (`@/services/paypal`) with webhook signature verification

---

## 📦 Verified Product Catalogue (14 Enterprise Benchmarks)

Stage 1 includes an authoritative, multi-category catalogue with comprehensive technical specifications, stock counts, lead times, and fixed pricing:

| Brand & Product | Category | Tier | Price (USD) | Key Highlight |
|---|---|---|---|---|
| **Herman Miller Aeron (Size B)** | Ergonomics | Flagship | $1,295.00 | 8Z Pellicle breathable suspension mesh & PostureFit SL |
| **Apple MacBook Pro 16"** | Computing | Flagship | $3,499.00 | M3 Max 14-core CPU, 30-core GPU, 36GB RAM, 1TB SSD |
| **Jarvis Bamboo Standing Desk (60")** | Ergonomics | Mid-Tier | $649.00 | Dual whisper-quiet motors, 4 presets, solid bamboo |
| **Dell UltraSharp 32" 6K Monitor** | Displays | Enterprise | $2,559.00 | 6K IPS Black (6144x3456), 4K HDR Sony webcam, 140W PD |
| **ThinkPad X1 Carbon Gen 12** | Computing | Flagship | $1,849.00 | Intel Core Ultra 7 155H, AI Boost NPU, 2.42 lbs |
| **Steelcase Gesture Chair** | Ergonomics | Flagship | $1,180.00 | 360-degree rotating arms, Core Equalizer dynamic support |
| **Apple Studio Display 27" 5K** | Displays | Flagship | $1,599.00 | 5K Retina, A13 Bionic chip, Center Stage camera |
| **Sony WH-1000XM5 Headphones** | Audio | Mid-Tier | $399.00 | Dual processors, 8 microphones, 30-hour battery life |
| **CalDigit TS4 Thunderbolt 4 Dock** | Peripherals | Flagship | $399.00 | 18 ports, 98W Power Delivery, dual 6K display support |
| **Shure SM7B Vocal Microphone** | Audio | Flagship | $399.00 | Dynamic cardioid, electromagnetic humbucking shield |
| **Logitech MX Master 3S + Mechanical** | Peripherals | Top Value | $249.00 | 8K DPI track-on-glass, low-profile quiet tactile keys |
| **LG 34" Curved WQHD OLED** | Displays | Flagship | $1,299.00 | 800R curve, 240Hz, 0.03ms GtG, infinite contrast |
| **Ubiquiti UniFi Dream Machine SE** | Networking | Enterprise | $499.00 | 10G SFP+, 2.5GbE WAN, 8x PoE switch, UniFi OS |
| **Dell XPS 15 9530** | Computing | Flagship | $2,199.00 | i9-13900H, RTX 4070 8GB, 32GB DDR5, 3.5K OLED Touch |

---

## 🛠️ Project Structure

```
ProcurePilot-AI/
├── .env.example                               # Environment configuration template
├── DEMO.md                                    # Evaluator-oriented demonstration guide
├── LICENSE                                    # MIT License
├── README.md                                  # Primary system architecture documentation
├── package.json                               # Dependencies and npm scripts
├── tsconfig.json                              # Strict TypeScript configuration
├── next.config.ts                             # Turbopack and Next.js configuration
├── migration-preflight-manifest.json          # Preflight scan manifest (SHA-256: 083e5373...)
├── migration-quarantine-manifest.json         # Quarantined orphan manifest (SHA-256: 46a14121...)
├── migration-simulated-orders-manifest.json   # Segregated synthetic captures (SHA-256: dabf3a93...)
├── migration-rehearsal-summary.json           # Historical migration rehearsal record
├── migration-provenance-rehearsal-summary.json# Provenance-enforced migration rehearsal record
├── shadow-read-rehearsal-summary.json         # Dual-read parity validation record
├── src/
│   ├── app/
│   │   ├── layout.tsx                         # Root layout with CartProvider
│   │   ├── globals.css                        # Deep navy palette and smooth animations
│   │   ├── page.tsx                           # High-converting SaaS landing page
│   │   ├── dashboard/page.tsx                 # Main application dashboard
│   │   └── api/
│   │       ├── approval/
│   │       │   ├── challenge/route.ts         # POST HMAC challenge generation
│   │       │   └── sign/route.ts              # POST digital signoff & auth token issuance
│   │       ├── cart/validate/route.ts         # POST authoritative price reconciliation
│   │       ├── catalog/route.ts               # GET verified catalogue with filters
│   │       ├── procure/route.ts               # POST natural-language procurement reasoning
│   │       └── paypal/
│   │           ├── create-order/route.ts      # POST server-side PayPal order creation
│   │           ├── capture-order/route.ts     # POST server-side PayPal order capture
│   │           └── webhook/route.ts           # POST verified webhook ingestion
│   ├── components/
│   │   ├── budget/                            # BudgetTracker, PurchaseSummary
│   │   ├── cart/                              # CartDrawer, CartItemRow, HumanApprovalGate
│   │   ├── catalog/                           # ProductCard, Filters, Catalog, Details Modal
│   │   ├── checkout/                          # OrderConfirmationModal, CheckoutReturnHandler
│   │   ├── comparison/                        # Multi-product spec comparison matrix
│   │   ├── navigation/                        # Navbar with budget pill & Footer
│   │   ├── procurement/                       # Chat Copilot, Thought Feed, Presets
│   │   └── ui/                                # Reusable Button, Badge
│   ├── context/
│   │   └── CartContext.tsx                    # Client state management & reconciliation hook
│   ├── db/
│   │   ├── migrations/                        # 001 through 008 sequential SQL migrations
│   │   ├── client.ts                          # PostgreSQL connection pool with safety guards
│   │   ├── config.ts                          # Validated DB configuration
│   │   ├── delta-reconciliation.ts            # Controlled delta reconciliation engine
│   │   ├── legacy-migration.ts                # Non-login restricted baseline importer
│   │   ├── legacy-preflight.ts                # Exact-decimal preflight scanner
│   │   ├── migrator.ts                        # Session advisory lock migration engine
│   │   └── reverse-export.ts                  # Reversible state export & rollback harness
│   ├── lib/
│   │   ├── security/                          # Audit logger, rate limiter
│   │   └── validation/                        # Zod payload schemas
│   ├── services/
│   │   ├── approval/                          # ApprovalService with fail-closed HMAC signing
│   │   ├── catalog/                           # Product data & authoritative CatalogService
│   │   ├── gemini/                            # Gemini Live API & Heuristic Procurement Engine
│   │   ├── paypal/                            # PayPal Orders v2 server bridge & OrderStore
│   │   └── shadow/                            # Shadow reader & consistency comparator
│   └── types/                                 # TypeScript interfaces for all domains
├── tests/
│   ├── adapters/                              # Read-adapter parity test suite
│   ├── db/                                    # Migrations, delta reconciliation, rehearsal suites
│   ├── integration/                           # Gemini live API tool calling tests
│   ├── monetary/                              # Exact monetary arithmetic tests
│   ├── security/                              # Approval anti-tampering, PayPal checkout lifecycle
│   ├── run-all-tests.ts                       # Unified test runner
│   └── test-isolation.ts                      # Isolated test directory manager
└── scripts/
    ├── db-init.ts                             # Database bootstrap utility
    └── db-import-baseline.ts                  # Baseline import runner
```

---

## ⚡ Setup & Installation

### Prerequisites

- **Node.js:** v18.18+ or v20+ (tested on Node v26.11)
- **Package Manager:** `npm` (included with Node.js)
- **PostgreSQL (Optional for local UI demo):** PostgreSQL 14+ is required only when running live database migrations or database test suites.

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/syedsenterprises/ProcurePilot-AI.git
cd procurepilot-ai
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to create your local `.env.local` file:

```bash
cp .env.example .env.local
```

Configure your environment settings:

```env
# 1. Google Gemini AI (Optional - if omitted, runs in Heuristic Rules Engine mode)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-flash-latest

# 2. Approval Security (Required for Human Approval Gate challenge generation)
APPROVAL_SECRET=your_secure_random_hmac_secret_here

# 3. PayPal Sandbox (Optional - if omitted, payment orders run in simulated mode)
PAYPAL_CLIENT_ID=your_paypal_client_id_here
PAYPAL_CLIENT_SECRET=your_paypal_client_secret_here
PAYPAL_ENVIRONMENT=sandbox
ALLOW_PAYPAL_SIMULATION=true

# 4. App URL
NEXT_PUBLIC_APP_URL=http://localhost:3000

# 5. PostgreSQL Database (Optional for prototype UI; required for test:db)
PGHOST=localhost
PGPORT=5432
PGDATABASE=procurepilot
PGUSER=procurepilot_app
PGPASSWORD=your_secure_password
```

> **Safe local evaluation:** Leave PayPal credentials unset and enable simulation only in a local development environment. Generate a fresh, private approval secret rather than copying a published example: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Set that value as `APPROVAL_SECRET` in your uncommitted `.env.local`. Without `GEMINI_API_KEY`, the app clearly identifies its heuristic fallback; with a valid key it uses the Gemini API. Simulation is not a PayPal transaction and must never be described as a genuine capture.

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser:
- **Landing Page:** `http://localhost:3000`
- **Application Dashboard:** `http://localhost:3000/dashboard`

### 4. Code Quality & Automated Test Verification

```bash
# TypeScript strict type-check (zero errors)
npm run type-check

# ESLint analysis (zero warnings/errors)
npm run lint

# Production build verification (Turbopack)
npm run build

# Run core security, checkout, and contract test suites
npm test

# Run isolated database test suites (requires local PostgreSQL)
npm run test:db
```

---

## 🗄️ Relational Persistence & Migration Architecture

ProcurePilot AI features an authoritative relational database foundation designed to enforce tenant isolation, monetary precision, append-only auditability, and race-free concurrency.

### Sequential Migration History (001–008)

The schema evolves through 8 sequential, idempotent SQL migrations under PostgreSQL advisory lock (`83921049281`):

| Migration | Name | Primary Purpose & Structural Security Controls |
|:---|:---|:---|
| **`001`** | `001_initial_schema.sql` | Establishes the 13 core relational tables, composite multi-tenant foreign keys, the deterministic seed organization (`00000000-0000-0000-0000-000000000001`), and check constraints enforcing the 12 canonical order states. |
| **`002`** | `002_refund_integrity.sql` | Implements high-concurrency refund race prevention. Introduces `create_refund_reservation(...)` with row-level `FOR UPDATE` locking on parent `orders`, plus `check_refund_balance_trigger` guaranteeing refund totals never exceed settled captures. |
| **`003`** | `003_refund_attempt_security.sql` | Hardens the refund write-path. Adds trigger blocking direct unvalidated attempt creation; introduces explicit failure/ambiguity procedures (`fail_refund_attempt`, `mark_refund_attempt_ambiguous`); revokes public write access. |
| **`004`** | `004_non_forgeable_refund_authorization.sql` | Establishes the non-login service role `procurepilot_refund_executor`. Wraps refund operations in `SECURITY DEFINER` procedures with hardcoded `search_path = pg_catalog, public`, eliminating session GUC spoofing risks. |
| **`005`** | `005_legacy_approval_provenance.sql` | Introduces provenance tracking (`source_origin = 'RUNTIME' \| 'LEGACY_JSON_IMPORT'`, `integrity_status = 'VERIFIED' \| 'UNVERIFIABLE_LEGACY'`). Creates non-login role `procurepilot_migration_importer` and append-only triggers preventing mutation of imported historical records. |
| **`006`** | `006_controlled_delta_reconciliation.sql` | Implements `reconcile_legacy_order_status_transition(...)` for controlled status reconciliation, session marker checks (`procurepilot.in_reconcile_transition`), and the `order_state_transition_audit` table. |
| **`007`** | `007_delta_reconciliation_security_hardening.sql` | Enforces mandatory session context verification inside triggers, revokes `PUBLIC` execute permissions on reconciliation functions, and installs an append-only trigger blocking `UPDATE` or `DELETE` on the transition audit trail. |
| **`008`** | `008_delta_reconciliation_wrapper_resolution.sql` | Resolves PostgreSQL ambiguous function overloading by establishing distinct 4-argument and 5-argument procedure signatures (removing ambiguous default parameters) and adds operator attribution to the audit trail. |

---

## 🔄 Controlled Delta Reconciliation Architecture

The `DeltaReconciler` (`src/db/delta-reconciliation.ts`) provides controlled, verifiable synchronization between flat-file storage and PostgreSQL:

1. **Safety Assertions (`assertDatabaseSafety`):**  
   Before any operation executes, the reconciler procedurally verifies:
   - Target database is an authorized test instance (`procurepilot_delta_test_*` or explicitly designated test DB).
   - Target database is strictly not the production database name.
   - `allowMutations: true` and `disposableEnvironmentMarker: 'DISPOSABLE_TEST_ENVIRONMENT'` are explicitly supplied.
   - Host, port, cluster system identifier, and connecting database user match expected authorization parameters.
2. **HMAC-to-Status Cryptographic Binding:**  
   Runtime approval tickets undergo strict state-bound validation:
   - `PENDING_APPROVAL`: Requires valid challenge signature; rejected if presenting approved-token signature.
   - `APPROVED`: Requires valid auth token signature; rejected if presenting challenge signature.
   - `CONSUMED`: Requires valid auth token signature and valid `consumedAt` timestamp.
   - Any signature tampering, expired TTL, cart manipulation, or empty signing key strictly fails closed.
3. **Trigger-Enforced Stored Procedure Execution:**  
   Direct `UPDATE` statements on legacy orders are rejected by database triggers. Status transitions must execute through `reconcile_legacy_order_status_transition`, which verifies the transaction-local marker `procurepilot.in_reconcile_transition`, validates the 12-state state machine, updates the order, and appends an immutable audit row.
4. **Complete Capture De-authorization:**  
   Flatfile capture records are strictly inspected. All 78 synthetic captures (`isSimulated: true`, `CAP_*`) are segregated from the database financial ledger. Adversarial flat-file records attempting to spoof real PayPal capture IDs without verifiable API provenance are rejected.

---

## 📦 Legacy Record Provenance & Quarantined Orphan

The legacy dataset in `.data/` consists of:
- **80 Valid Orders:** Totaling $109,932.60 ($589.08 genuine PayPal orders, $109,343.52 simulated orders). Imported with `source_origin = 'LEGACY_JSON_IMPORT'` and protected by immutability triggers.
- **219 Legacy Approval Tickets:** Totaling $377,852.52. Imported with `integrity_status = 'UNVERIFIABLE_LEGACY'` because they pre-date runtime cryptographic session token binding. They remain valid audit records but cannot authorize new runtime checkouts.
- **1 Quarantined Orphan Order (`TEST-ORDER-MUTATION-CHECK-01.json`):**  
  References non-existent approval ticket `TICKET-TEST-10`. Excluded from database import and recorded in `migration-quarantine-manifest.json` (SHA-256: `46a14121...`). Direct file SHA-256 is recorded as `302cce32f4cf72e5eee4a999efcceb98b5fedc42a0a7363675db096b9fe85843`.
- **1 Genuine PayPal Capture:** `$294.54 USD` bound to genuine order `8HX72491AA582924T`.
- **78 Synthetic Test Captures:** Excluded from the PostgreSQL financial ledger.

---

## 🔒 Cryptographic Approval Lifecycle & Secret Encapsulation

ProcurePilot AI implements strict zero-trust cryptographic encapsulation in `ApprovalService` (`src/services/approval/approval.service.ts`):

- **No Public Secret Accessors:** The service contains zero public getters (such as `configuredSecret`) and zero runtime setters (`setSecret`). The signing key is held strictly in private scope.
- **Secure Constructor & Environment Resolution:** The service accepts an optional constructor-injected secret for test-isolated instances. In runtime operation, it dynamically resolves `process.env.APPROVAL_SECRET || process.env.NEXTAUTH_SECRET`.
- **Fail-Closed Semantics:** If both secrets are absent or empty, any signing or verification attempt throws an explicit cryptographic configuration error. Predictable hard-coded development keys are strictly prohibited.
- **Timing-Safe Equality:** All HMAC signature comparisons utilize `crypto.timingSafeEqual` over fixed-length buffer digests to eliminate side-channel timing attacks.

---

## 🛡️ Database Role Isolation & Append-Only Auditing

PostgreSQL security boundaries follow the principle of least privilege:
- **Default Public Privileges Revoked:** `REVOKE ALL ON SCHEMA public FROM PUBLIC` prevents unprivileged roles from creating objects or executing stored procedures.
- **Non-Login Service Roles:** Roles such as `procurepilot_refund_executor` and `procurepilot_migration_importer` own sensitive operations and cannot be logged into directly.
- **Locked Search Paths:** All `SECURITY DEFINER` functions explicitly lock `search_path = pg_catalog, public` to eliminate search_path shadowing exploits.
- **Append-Only Triggers:** Audit tables (`order_state_transition_audit`, `payment_events`, `audit_events`) have `BEFORE UPDATE OR DELETE` triggers that throw exceptions, guaranteeing an immutable historical audit trail.

---

## ⚠️ Current Runtime Boundaries & Explicit Limitations

To maintain absolute technical transparency, the following architectural boundaries and current limitations must be recognized:

1. **No Production Database Cutover Has Occurred:**  
   The application runtime currently operates against the file-backed JSON store (`.data/`). PostgreSQL migration, schema constraints, and delta reconciliation have been validated in isolated rehearsal and test environments. Dual-writes and live production traffic routing to PostgreSQL have not been enabled.
2. **File-Backed Runtime Remains Authoritative:**  
   The server-side Next.js route handlers (`/api/cart/validate`, `/api/paypal/create-order`, `/api/paypal/capture-order`) read from and write to the `.data/` directory.
3. **Legacy Approvals Are `UNVERIFIABLE_LEGACY`:**  
   The 219 historical approval tickets lack cryptographic runtime session signatures. They are intentionally classified with `integrity_status = 'UNVERIFIABLE_LEGACY'` and cannot authorize new runtime checkouts.
4. **Synthetic Captures Are Excluded from the Ledger:**  
   78 synthetic test captures are segregated from the database financial ledger.
5. **Human Operator Identity Is Not Yet Authenticated via SSO:**  
   Enterprise SSO (OIDC/SAML) is not yet integrated. Requisition signoffs use self-attested identity (`SELF_ATTESTED_REQUISITIONER`), and migration reconciliation uses parameter-based operator attribution.
6. **Environment Safety Guards Are Procedural:**  
   The safety checks in `assertDatabaseSafety()` (`authorizedTargetDatabase`, `disposableEnvironmentMarker`, host/port/cluster ID checks) prevent accidental tool and developer misuse, but are procedural software assertions, not cryptographic hardware attestation.

---

## 📄 License

This project is open-source software licensed under the **[MIT License](LICENSE)**.
