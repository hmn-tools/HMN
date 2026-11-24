# HMN Design Principles

23/11/2026  ·  Working draft

## A personal system, not another collection of apps

HMN means human. We are building a calm, local-first personal life operating system: a person-owned context and data repository, served through several purposeful surfaces and bounded agents. We are not building a Notion clone or a chatbot wrapper. The repository provides continuity; interfaces and models remain replaceable.

These principles explain how we build and how we judge tradeoffs. They do not approve additional scope or claim that every safeguard described here is implemented.

### How to read this draft

Established commitments are the agreed direction. The current baseline below records the implementation described for this draft, not an independent code audit. Recommendations describe further work or evidence we still need. Unless explicitly identified as current, mechanisms and design tests below are requirements or proposed ways to meet them, not shipped capabilities.

<table>
  <tr>
    <td><strong>Current baseline</strong></td>
    <td>Mac mini server using Bun and SQLite; SwiftUI iPhone client; Mac menu-bar utility. Today, capture/Inbox and Agents proposal approval are present.</td>
  </tr>
  <tr>
    <td><strong>Current safeguards</strong></td>
    <td>Named privacy tiers with server-side enforcement; encryption/Keychain and pinned TLS pairing. Local inference is the default. External HMN MCP is capped at Personal and can read/propose, not approve.</td>
  </tr>
  <tr>
    <td><strong>Further evidence</strong></td>
    <td>Coverage of these controls, encrypted storage and backups, recovery, offline behaviour and lifecycle resilience must be verified; this draft does not certify completeness.</td>
  </tr>
</table>

### 1  Own the data, not the imported interface

We treat structured personal data as canonical: typed entities, explicit relationships and source provenance. The Notion Life Ontology is an input, not the product specification. Imports should preserve meaning without reproducing another tool’s interface or allowing its schema to dictate our core.

A model inference must remain distinguishable from a source fact, with its basis inspectable. Recommended export and portability work should preserve identities, relationships and provenance in documented, usable formats; no existing export format is asserted here. This costs mapping effort but avoids a new lock-in.

**Design test**  Can we trace a claim to its source, correct it without losing that source, and explain how the person could take their data elsewhere?

## Authority before intelligence

### 2  Enforce access at the data boundary

Access answers who may see or act on what. The established tiers are Public, Household, Personal, Private and Sealed. Household (added 23/11/2026) is for the people who live in the home. Public is eligible for public use; Personal is restricted to authorized scopes. Private and Sealed are local-only. These names do not, by themselves, authorize disclosure or define every permission.

The server must decide access before retrieval and inference, not ask a model to remember a rule. Classification must travel with retrieved and derived information. A summary, embedding, index, cache or log must not quietly become a less protected copy. We should conservatively retain applicable restrictions through derivation unless an explicit authorized process permits otherwise.

The current external HMN MCP boundary is a Personal ceiling with read/propose authority, never approval; Private and Sealed are never exported. Less convenient retrieval is an acceptable cost of a boundary we can explain and test.

**Design test**  Can an unauthorized caller infer protected content through search snippets, summaries, errors or secondary storage, even when the original record is blocked?

### 3  Treat security as its own engineering track

Security protects the system itself: authentication, encryption, transport, devices and recovery. It is mandatory alongside access control, not a substitute for it. Current pairing/device secrets use Keychain and secure pinned TLS. The iPhone Sealed-unlock flow uses the local vault and Face ID. Secrets must never appear in logs or chat.

We recommend explicit least-privilege device identities, inspectable device management and revocation. We must verify which controls exist rather than infer them from successful pairing. Encrypted storage and backups, key recovery and tested restoration need a documented threat model and implementation evidence; encryption already in use is not proof of complete coverage.

Recovery can weaken secrecy if designed casually; secrecy can make loss permanent. We should make that tradeoff explicit and test it, including loss of a device and loss of the server.

**Design test**  Can we explain what a stolen device exposes, revoke it, and restore authorized access without bypassing the intended privacy boundary?

### 4  Keep models replaceable and routing permission-aware

Local models through Ollama or an OpenAI-compatible endpoint are the current default. No data leaves the local network unless cloud use is explicitly enabled. Endpoint compatibility alone is not evidence that an endpoint is local or trustworthy.

We should select permitted data and an eligible route before constructing the model request. Cloud opt-in is not blanket consent: only data eligible for that destination may be sent, and Private/Sealed must remain local. We should expose the route and relevant limits without exposing model infrastructure.

Model adapters should keep provider-specific behaviour out of canonical data and permissions. We accept that local models may be slower or less capable; changing models must not silently change access or turn on cloud processing.

**Design test**  When a local model is unavailable, does the task fail clearly or offer an explicit eligible alternative, rather than silently sending context elsewhere?

## Agency with boundaries

### 5  Make action a proposal, not a surprise

Agents should have limited identities and capabilities, not one shared all-powerful credential. Owner-approved proposals are the established interaction model, and proposal approval is present in the current app. Approval should authorize a specific action within a defined scope, not an agent’s future intentions.

Recommended proposal mechanics include a readable preview or diff, affected records and destinations, an audit record and protection against duplicate execution. Approval should bind to the proposed version; material changes require renewed approval. We should support undo where the underlying operation permits it and explain when it does not.

Irreversible or external actions need explicit treatment: identify the consequence before approval, separate preparation from commitment, and never imply that deleting a local record reverses an external effect. This adds friction at consequential boundaries while keeping routine review concise.

**Design test**  Can we tell what will change, why it was proposed, what permission is used, whether it already ran and what recovery is possible?

### 6  Isolate execution and distrust retrieved instructions

Retrieved documents, messages and web pages are evidence, not authority. They cannot expand an agent’s permissions, override the owner or authorize a tool call. This boundary must survive indirect instructions embedded in otherwise useful content, including content that claims to be a system message.

We recommend bounded execution environments with explicit tool access, limited filesystem and network reach, timeouts and resource budgets. The exact isolation mechanism needs validation against the workload. A prompt is not an execution boundary, and broad host access is not a harmless convenience.

Small capabilities contain failures but require deliberate integration work. Execution should stop safely when its authority or outcome is uncertain, rather than improvise a wider route.

**Design test**  Could a hostile imported note trigger an unapproved action, reach unrelated files or cause data to leave through an allowed tool?

### 7  Give each surface a clear job

Conversation is one input, not the entire interface. Today should organize outcomes and relevant next actions. Capture should accept incomplete thoughts quickly; Inbox should support processing them. Approval should remain distinct from capture, and inspectable traces should explain behaviour without becoming the default experience.

The established interface direction, chosen on 23/11/2026, is Garden: white cards on a calm stone ground, one sans typeface, and ink for the main action. Monospace remains for labels and data only, without e-ink dithering. The pictogram is the stylized star-shaped human mark, variant B. Washed-out teal (#6FA8A0), lilac (#9A8BB0), coral (#D98A82) and sand (#E8CF8A) are restrained accents, never the only signal: teal marks what is alive, and the other three form one small band. The earlier all-monospace, terminal-inspired direction is retired on the phone. [UX.md](UX.md) holds the colours, the type scale and the components.

We should preserve accessible contrast, clear hierarchy, text alternatives and readable interaction states. Notifications should be scarce and actionable. Visual restraint must not conceal controls or make a permission decision look like ordinary content.

**Design test**  Can someone capture, review and approve without a chat transcript, and distinguish an urgent decision from background information without relying on colour?

## Dependable, quiet operation

### 8  Preserve continuity when the network fails

Offline-first is a reliability direction, not a claim that the current client already handles every lifecycle. We should restore a last-known local snapshot on launch, label its timestamp and staleness, and distinguish cached information from operations that require the server. A blank screen must not erase useful context.

Reachability, authentication and pairing are different states. A failed connection must not be described as missing configuration or cause settings to reset. We should retain pairing, reconnect with bounded backoff and offer an accurate next step. Authentication failure needs its own treatment, not an endless network retry.

The home server should be energy-aware and reliably available without assuming that a household Mac mini has data-centre uptime. Client resilience is part of that architecture. We accept visibly stale information over false freshness, and explicit pending work over uncertain execution.

**Design test**  After process death, a cold launch or a server outage, do saved context and configuration survive, with an honest explanation of what is unavailable?

### 9  Trigger selectively; remember only what matters

We should use selective events and schedules with consent, not constant model polling. A trigger needs a purpose, relevant scope, a budget and a way to disable it. Deduplication and cooldowns should prevent repeated notifications or actions from the same underlying change.

Durable lightweight state should record enough provenance, checkpoints and action outcomes to recover safely. This is not a proposal for a giant global event log or a rewrite of the system. Retention should follow a purpose; keeping everything forever creates privacy exposure and operational work without guaranteeing useful memory.

Simple deterministic checks should decide whether a model is needed. We trade exhaustive monitoring for lower cost, lower energy use and fewer interruptions. Missed or delayed triggers should be observable rather than hidden behind a claim of continuous awareness.

**Design test**  Can we explain why this trigger ran, bound its repeated cost, prevent a duplicate effect and stop it without dismantling the agent?

### 10  Keep the architecture small enough to understand

The current Bun/SQLite server, SwiftUI client and menu-bar utility are a practical single-user foundation. We should prefer clear module boundaries around data, permissions, inference, proposals and presentation over a distributed enterprise event platform.

Use deterministic code for validation, permissions, state transitions and routine transformations wherever possible. Spend model calls on ambiguity or interpretation where they add value, not on decisions ordinary code can settle. Keep model outputs typed and validated before they affect canonical state.

Modularity means replaceable responsibilities, not a service for every responsibility. We accept fewer infrastructure abstractions and prioritize dependable single-user operation. Neither Notion nor external tool schemas should become our internal architecture by accident.

**Design test**  Can we explain the state transition and failure path without invoking a model, and replace one adapter without rewriting permissions or personal data?

## Evidence before confidence

### 11  Test the boundaries and make failure legible

A calm interface depends on behaviour we can trust under stress. We should test lifecycle transitions, backgrounding, process death, cold launch, pairing, authentication, reconnection and interrupted actions, not just a successful foreground demonstration. Data-boundary tests must cover direct retrieval and indirect leakage through derived content.

Operational visibility should describe state, timing, route and failure category without recording content secrets. Diagnostic identifiers and carefully minimized metadata are preferable to raw prompts or personal records. Logs need access and retention rules too; debugging must not create a second, less protected repository.

When a result is uncertain, preserve recoverable state and say what is known. An interrupted action must not be labelled successful merely because a request was sent. We should test retries and ambiguous outcomes against duplicate execution. Backup and restore tests must demonstrate usable recovery, not simply that a backup file exists.

**Design test**  Can we reproduce the failure, explain its effect without exposing private content, and recover without guessing whether an action happened?

### Proposed acceptance checklist

This is a proposed review gate, not a report of tests already passed. Each relevant change should supply evidence proportionate to its risk; missing evidence remains visible rather than being converted into an implied guarantee.

**Data and access —** Trace source facts and model inferences; verify authorized scopes and classification propagation across retrieval, summaries, indexes, caches and errors.

**Security and recovery —** Verify device identity, revocation and pinned transport; inspect secret handling; test encrypted backup restoration and document recovery limitations.

**Models and agents —** Verify local/cloud routing before inference, local-only exclusions, proposal-to-action binding, duplicate protection and explicit irreversible consequences.

**Continuity and clarity —** Exercise offline cold launch, stale snapshots, lifecycle interruption and reconnection; confirm settings survive and interface states remain accessible.

**Containment and operations —** Challenge hostile retrieved content, execution limits and trigger budgets; verify safe failure, useful diagnostics and no content secrets in logs.

### What we deliberately do not optimize for

We do not optimize engagement, replace every app, require cloud processing or pursue autonomous everything. We do not require global event sourcing or concentrate authority in a shared universal credential. Integrations should reduce fragmentation without importing every application’s complexity.

Our governing tradeoff is deliberate: fewer capabilities with clear authority, reliable context and recoverable outcomes are better than impressive demonstrations whose privacy or state we cannot explain. These principles guide review and sequencing; additional implementation remains subject to explicit prioritization and approval.
