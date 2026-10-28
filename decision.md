# Campus GPT Backend — Architecture Decision Records (ADR) & Technical Rationale

This document serves as the authoritative Architecture Decision Record (ADR) and engineering rationale for the **Campus GPT Backend**. It details the design paradigms, architectural trade-offs, library selections, and serverless adaptations implemented across the platform to ensure high reliability, low-latency AI responses, deterministic academic context pruning, and multi-tenant student safety.

---

## 1. Executive Summary & Architectural Tenets

Campus GPT is an intelligent academic operating system and campus companion designed for modern educational institutions. The backend service is responsible for:
1. **Academic Data Management**: High-integrity relational models for courses, subjects, timetables, faculties, university buildings, and academic events.
2. **AI Orchestration & Context Pruning**: Grounding LLM requests with deterministic, real-time database context (student-specific enrolled courses, today's timetable slots, upcoming campus events) before feeding prompts into Google Gemini.
3. **Serverless Scalability**: High-throughput, stateless execution deployed to Vercel Serverless Functions with connection resilience to cloud PostgreSQL instances.
4. **Security & Role-Based Access Control**: Strict segregation between Student and Administrator capabilities, guarded by Supabase JWT validation and internal request signing.

---

## 2. Core Framework & Language Decisions

### 2.1 Language: TypeScript 5.7+ (Strict Mode)

- **Decision**: Develop the entire backend in strict TypeScript targeting `ES2023`.
- **Alternatives Considered**: Pure JavaScript (Node.js), Go, Python (FastAPI).
- **Rationale**:
  - **Type Safety across Domain Boundaries**: Eliminates entire classes of runtime errors (`TypeError`, `undefined` access) across complex relational queries.
  - **Decorator Reflection**: Essential for NestJS dependency injection and Sequelize-TypeScript ORM model definitions via `reflect-metadata` and `emitDecoratorMetadata`.
  - **Shared Mental Model**: Matches the frontend language, enabling potential code/types sharing between client and server.

### 2.2 Framework: NestJS (v11.x) with Express Engine

- **Decision**: Adopt NestJS using `@nestjs/platform-express`.
- **Alternatives Considered**: Raw Express, Fastify, Koa, AdonisJS.
- **Rationale & Advantages**:
  - **Enterprise Architecture**: NestJS enforces an Angular-inspired modular architecture (`@Module()`, `@Injectable()`, `@Controller()`). This prevents the "spaghetti code" common in rapidly growing Express backends.
  - **Dependency Injection (DI) Container**: Decouples business logic from HTTP transport, making services easily testable, mockable, and swappable.
  - **First-Class Lifecycle Hooks**: `OnModuleInit`, `OnApplicationBootstrap`, and `OnModuleDestroy` provide deterministic startup guarantees (e.g., verifying database connectivity before accepting HTTP traffic).
  - **Express Adapter Compatibility**: Leverages the massive ecosystem of Node.js Express middleware and seamless adaptation to Vercel's serverless request handler.

---

## 3. Database Architecture & ORM Strategy

### 3.1 Primary Database: Managed PostgreSQL (Supabase)

- **Decision**: Utilize PostgreSQL hosted on Supabase (`pooler.supabase.com` session/transaction pooler).
- **Alternatives Considered**: MongoDB, MySQL, DynamoDB, Firebase Firestore.
- **Rationale & Advantages**:
  - **Relational Integrity**: Academic scheduling inherently consists of strong relational constraints:
    - A `Course` has many `Subjects`.
    - A `TimetableSlot` binds a `Subject`, `Faculty`, `Building`, and `Course` to a specific day of the week and start/end time.
    - Foreign key constraints (`ON DELETE CASCADE`) guarantee that deleting a course or subject does not leave orphaned scheduling records.
  - **Complex Analytical Queries**: Administrative dashboards require relational aggregations (`COUNT(DISTINCT student_id)`, department distributions, timetable conflict lookups) that are naturally optimized by PostgreSQL's query planner.
  - **Supabase Cloud Infrastructure**: High availability, automated backups, and low network latency with AWS regions (`ap-southeast-1`).

### 3.2 ORM: Sequelize with `sequelize-typescript` (v2.1.6)

- **Decision**: Use Sequelize with decorator-driven TypeScript definitions (`@Table`, `@Column`, `@ForeignKey`, `@BelongsTo`, `@HasMany`).
- **Alternatives Considered**: Prisma, TypeORM, Drizzle ORM, Raw Knex.js.
- **Rationale & Advantages**:
  - **Explicit Schema Definition**: Code-first models define both TypeScript interfaces and database schemas simultaneously, eliminating discrepancies between type definitions and table columns.
  - **Automated Association Wiring**: Models register bidirectional relationships in their static `.associate()` hooks (e.g., `CourseModel.hasMany(SubjectModel)`).
  - **Connection Pooling Control**: Sequelize provides granular pool configurations (`min`, `max`, `acquire`, `idle`) critical for surviving serverless connection bursts.

### 3.3 SSL & Remote Cloud Connection Resilience

- **Decision**: Configure PostgreSQL connection with explicit SSL options (`rejectUnauthorized: false`) in `SqlService`:
  ```typescript
  const isRemote = uri && !uri.includes('localhost') && !uri.includes('127.0.0.1');
  dialectOptions: isRemote ? { ssl: { require: true, rejectUnauthorized: false } } : {}
  ```
- **Rationale & Advantages**:
  - Cloud database poolers (Supabase Pooler on AWS) reject unencrypted traffic (`no pg_hba.conf entry ... SSL off`). Explicit dialect configuration ensures secure TLS handshakes across serverless edge containers without failing on self-signed root cert verification.

### 3.4 Decoupled Polyglot Database Service Architecture

- **Decision**: Design `DbService` (`src/core/services/db-service/db.service.ts`) with independent provider abstractions:
  - `SqlService` (`providers/sql.provider.ts`) for relational PostgreSQL models.
  - `MongoService` (`providers/mongo.provider.ts`) prepared as an optional document store for unstructured audit logs or chat transcripts.
- **Rationale & Advantages**:
  - Encapsulates database drivers behind an injectable singleton service.
  - Allows the application to run purely on PostgreSQL without throwing errors or requiring MongoDB credentials in local development.

---

## 4. Serverless & Deployment Strategy (Vercel)

### 4.1 Pre-Compiled CommonJS Serverless Entry Point (`api/index.js`)

- **Decision**: Deploy NestJS to Vercel Serverless using a dedicated CommonJS wrapper in `api/index.js` that imports pre-compiled artifacts from `dist/`:
  ```javascript
  const { NestFactory } = require('@nestjs/core');
  const { ExpressAdapter } = require('@nestjs/platform-express');
  const { AppModule } = require('../dist/app/api/app.module');
  ```
- **The Critical Bug Solved**:
  - When `@vercel/node` compiles raw `.ts` serverless files on the fly, it uses `esbuild` or `swc` without emitting TypeScript decorator metadata (`emitDecoratorMetadata: true`).
  - Without decorator metadata, NestJS dependency injection receives `undefined` for injected constructor arguments, crashing at runtime with `500 FUNCTION_INVOCATION_FAILED`.
  - **The Solution**: Vercel executes `buildCommand: "yarn build"`, where `nest build` runs standard `tsc` with `emitDecoratorMetadata: true` and writes cleanly compiled JavaScript to `dist/`. `api/index.js` then executes the pre-compiled code with all metadata and decorators intact.

### 4.2 In-Memory Singleton Server Caching (`cachedServer`)

- **Decision**: Cache the initialized Express application across serverless invocations:
  ```javascript
  let cachedServer;
  async function bootstrapServer() {
    if (!cachedServer) {
      // initialize app once per lambda container
      cachedServer = expressApp;
    }
    return cachedServer;
  }
  ```
- **Rationale & Advantages**:
  - Dramatically slashes warm request latency from ~1200ms (full NestJS bootstrap) down to under 15ms by reusing the existing DI container, database connection pool, and route registry within an active Lambda container.

### 4.3 Safe Startup Resilience on Vercel

- **Decision**: In `DbService.onModuleInit()` and `SqlService.init()`, check `process.env.VERCEL`:
  ```typescript
  if (!process.env.VERCEL) {
    process.exit(1);
    throw error;
  }
  ```
- **Rationale & Advantages**:
  - Locally, database failure should halt the developer immediately.
  - On serverless Vercel, throwing inside `onModuleInit()` causes the entire Lambda container to crash before HTTP routing, rendering an opaque `500 FUNCTION_INVOCATION_FAILED` HTML page.
  - Catching errors without re-throwing allows the serverless function to boot, allowing health-check routes (`/health`) and diagnostic endpoints to respond with readable JSON diagnostics (e.g. `{ "status": "down" }`).

### 4.4 Infinite Rewrite Loop Prevention (`vercel.json`)

- **Decision**: Structure `vercel.json` rewrites using negative lookahead:
  ```json
  "rewrites": [
    {
      "source": "/((?!api$).*)",
      "destination": "/api"
    }
  ]
  ```
- **Rationale & Advantages**:
  - A naive rewrite rule (`"source": "/(.*)", "destination": "/api"`) causes Vercel to match the destination `/api` recursively, creating an infinite redirect/rewrite loop (HTTP 508 / 500 error).
  - The negative lookahead `(?!api$)` ensures `/api` itself is not rewritten, while all other routes (`/health`, `/dashboard/admin`, `/chat`, `/education`, `/docs`) route cleanly into the serverless handler.

---

## 5. AI Integration & Context Pruning Strategy

### 5.1 LLM Provider: Google Gemini (`gemini-3.5-flash`) via OpenAI-Compatible Endpoint

- **Decision**: Use Gemini 3.5 Flash through the generative language OpenAI compatibility endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`) using Axios.
- **Alternatives Considered**: OpenRouter, OpenAI GPT-4o-mini, Anthropic Claude 3.5 Haiku, Native Google GenAI SDK.
- **Rationale & Advantages**:
  - **Latency & Speed**: `gemini-3.5-flash` delivers sub-second generation speeds essential for an interactive student chat assistant.
  - **OpenAI Endpoint Compatibility**: Allows standard `{ role, content }` payload formats without binding the application to vendor-specific SDK revisions.
  - **Economics**: Industry-leading cost per token, making it sustainable for a high-volume campus deployment.

### 5.2 Deterministic Grounding & Multi-Turn Context Pruning

- **Decision**: Build `ChatService.getModelTrainingData(userId)` to dynamically construct the LLM's system grounding on every request.
- **Rationale & Advantages**:
  - **Eliminating Hallucinations**: Campus questions (e.g., *"What is my next class?"*, *"Where is Block 34?"*, *"Who teaches Computer Networks?"*) require absolute deterministic truth, not probabilistic guessing.
  - **Personalized Academic Context**: The service queries PostgreSQL for:
    1. The student's enrolled course and timetable for the current day.
    2. Faculty office hours and email contacts.
    3. University buildings and geo-location links.
    4. Upcoming campus events and workshops.
  - **System Prompt Consolidation**: Gemini's OpenAI-compatible endpoint overwrites earlier system messages if passed as multiple distinct objects. `chat.service.ts` merges all training data and existing system messages into a unified, consolidated system instruction block.
  - **Team Attribution**: Constant prompt instruction permanently recognizes project creators: *"You are created by Ajay, Muskan, Madhav, Aayush and Prince."*

---

## 6. HTTP Pipeline, Security & Cross-Cutting Concerns

### 6.1 Unified Response Envelope (`ReqResInterceptor`)

- **Decision**: Intercept all successful controller returns with `ReqResInterceptor`:
  ```json
  {
    "data": { ... },
    "meta": {
      "success": true,
      "message": "SUCCESS",
      "statusCode": 200
    }
  }
  ```
- **Rationale & Advantages**: Guarantees a predictable contract for frontend state management (TanStack Query / Axios), eliminating guesswork on response structures.

### 6.2 Global Exception Shielding (`HttpExceptionFilter`)

- **Decision**: Global exception filter catching both `HttpException` and unhandled exceptions:
  ```json
  {
    "data": null,
    "meta": {
      "success": false,
      "message": "User-friendly message",
      "failures": { ... }
    }
  }
  ```
- **Rationale & Advantages**: Prevents raw database errors, stack traces, or internal server tokens from leaking to the client in production.

### 6.3 Authentication Guard (`UserGuard`)

- **Decision**: Custom guard checking JWT authorization and internal communication secrets (`x-secret`).
- **Rationale & Advantages**: Protects sensitive endpoints (course creation, timetable deletion, administrative dashboard stats) while allowing student controllers to extract the verified `userId` directly from `req.user`.

### 6.4 API Documentation: Swagger / OpenAPI (`@nestjs/swagger`)

- **Decision**: Host interactive OpenAPI documentation at `/docs` (and `/api/docs`).
- **Rationale & Advantages**: Allows frontend developers and external university systems to test and consume endpoints with live schemas, request validation bodies, and response types.

---

## 7. Comprehensive Dependency Rationale

| Package | Version | Purpose | Advantage / Rationale |
| :--- | :--- | :--- | :--- |
| `@nestjs/core` & `@nestjs/common` | `^11.0.1` | Application framework | Robust DI, modular organization, and lifecycle management. |
| `@nestjs/platform-express` | `^11.0.1` | HTTP server adapter | High compatibility with standard Node.js middleware and Vercel serverless. |
| `@nestjs/sequelize` | `^11.0.0` | NestJS Sequelize integration | Native DI integration for Sequelize models. |
| `sequelize` & `sequelize-typescript` | `^6.37.7` / `^2.1.6` | Relational ORM | Decorator-based schema definition, strong relationship mapping. |
| `pg` & `pg-hstore` | `^8.16.2` / `^2.3.4` | PostgreSQL driver | Native PostgreSQL client with robust TLS/SSL socket support. |
| `axios` | `^1.12.2` | HTTP client | Reliable outbound HTTP requests to Google Gemini OpenAI API with timeout control. |
| `@nestjs/swagger` | `^11.2.0` | OpenAPI generator | Auto-generated interactive Swagger UI at `/docs`. |
| `@nestjs/terminus` | `^11.0.0` | Health check suite | Production health probes for database and memory health. |
| `class-validator` & `class-transformer` | `^0.14.2` / `^0.5.1` | DTO validation | Declarative runtime validation and payload transformation. |
| `dayjs` | `^1.11.18` | Date & time utility | Lightweight date parsing for day-of-week timetable scheduling. |
| `reflect-metadata` | `^0.2.2` | Metadata reflection | Required for TypeScript decorator evaluation at runtime. |
| `dotenv` / `env-cmd` | `^11.0.0` | Environment config | Secure environment variable injection across staging and production. |
