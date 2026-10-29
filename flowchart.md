# Campus GPT Backend — Code Execution & Request Flowcharts

This document provides exhaustive, production-grade flowcharts, sequence diagrams, and lifecycle architectures for the **Campus GPT Backend**. It traces code execution from the edge (Vercel Serverless Function) through all NestJS layers (Interceptors, Guards, Pipes, Controllers, Services, Models, and External AI APIs) with zero omitted details.

---

## 1. High-Level Request Pipeline Architecture

Every incoming HTTP request to the Campus GPT Backend traverses a deterministic, multi-stage processing pipeline before reaching business logic and returning a standardized response envelope.

```mermaid
flowchart TD
    Client["Client (Web Browser / Mobile App)"] -->|"HTTPS Request"| Edge["Vercel Edge Network (bom1 / iad1)"]
    
    subgraph Vercel_Routing["Vercel Routing & Serverless Layer"]
        Edge -->|"Check Rewrites in vercel.json"| RewriteCheck{"Matches ((?!api$).*) ?"}
        RewriteCheck -->|"Yes (e.g. /health, /dashboard)"| RewriteToApi["Rewrite destination to /api"]
        RewriteCheck -->|"No (exact /api)"| Passthrough["Direct Pass to /api"]
        RewriteToApi --> ServerlessEntry["Serverless Function: api/index.js"]
        Passthrough --> ServerlessEntry
    end

    subgraph Serverless_Handler["api/index.js Execution"]
        ServerlessEntry --> HandlerFunc["handler(req, res)"]
        HandlerFunc --> CheckCache{"cachedServer exists?"}
        CheckCache -->|"No (Cold Start)"| Bootstrap["bootstrapServer()"]
        CheckCache -->|"Yes (Warm Request)"| InvokeExpress["Execute cachedServer(req, res)"]
        Bootstrap --> CacheInstance["Store expressApp in cachedServer"]
        CacheInstance --> InvokeExpress
    end

    subgraph NestJS_HTTP_Pipeline["NestJS Execution Pipeline"]
        InvokeExpress --> GlobalLogger["LoggerInterceptor (src/core/services/logger)"]
        GlobalLogger --> UserGuardCheck["UserGuard (src/core/guards/guards.ts)"]
        
        UserGuardCheck -->|"Invalid Auth / Secret"| HttpFilterErr["HttpExceptionFilter (401 / 403)"]
        UserGuardCheck -->|"Valid / Public Route"| ValidPipe["ValidationPipe (class-validator)"]
        
        ValidPipe -->|"Payload Invalid"| HttpFilterErr
        ValidPipe -->|"Payload Valid"| ControllerRoute["Target Controller Method"]
        
        ControllerRoute --> DomainService["Target Domain Service"]
        DomainService --> DatabaseCall["DbService / SqlService (PostgreSQL)"]
        DomainService -.->|"If AI Request"| GeminiAPI["Google Gemini LLM Endpoint"]
        
        DatabaseCall --> DomainService
        GeminiAPI -.-> DomainService
        DomainService --> ControllerRoute
        ControllerRoute --> ResponseEnvelope["ReqResInterceptor (Formats envelope)"]
        ResponseEnvelope --> ReturnSuccess["200/201 JSON Response to Client"]
    end

    HttpFilterErr --> StandardizedErr["Standardized Error JSON Envelope"]
    StandardizedErr --> Client
    ReturnSuccess --> Client
```

---

## 2. Serverless Cold-Start & Bootstrap Lifecycle

When a Lambda container is instantiated by Vercel, the NestJS application is lazily created and initialized once. Subsequent requests reuse the warm in-memory container.

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Vercel as Vercel Edge
    participant Handler as api/index.js (handler)
    participant Nest as NestFactory
    participant Module as AppModule
    participant DB as DbService (onModuleInit)
    participant SQL as SqlService (authenticate)
    participant Express as ExpressAdapter

    Client->>Vercel: HTTP Request (e.g. GET /dashboard/student)
    Vercel->>Handler: Invoke handler(req, res)
    
    alt Cold Start (cachedServer is undefined)
        Handler->>Handler: bootstrapServer()
        Handler->>Nest: NestFactory.create(AppModule, new ExpressAdapter(expressApp))
        Nest->>Module: Resolve Dependency Graph
        Module->>DB: Instantiate DbService & SqlService
        SQL->>SQL: Initialize Sequelize Models & Associations
        Nest->>DB: Trigger onModuleInit()
        DB->>SQL: sqlConnection.init()
        SQL->>SQL: sequelize.authenticate() with SSL
        SQL-->>DB: ✅ Connection Authenticated
        DB-->>Nest: ✅ Module Initialization Complete
        Nest->>Express: Attach ValidationPipe, Cors, LoggerInterceptor
        Nest->>Nest: Setup Swagger docs at /docs
        Nest->>Express: app.init()
        Handler->>Handler: cachedServer = expressApp
    else Warm Request (cachedServer is defined)
        Handler->>Handler: Reuse existing cachedServer instance
    end

    Handler->>Express: cachedServer(req, res)
    Express-->>Client: Standardized JSON Response
```

---

## 3. Authentication & Security Guard Flow (`UserGuard`)

Protected endpoints require verification of student or admin identity via Bearer tokens or secret headers.

```mermaid
flowchart TD
    Req["Incoming Request into Route Handler"] --> Guard["UserGuard.canActivate(context)"]
    Guard --> GetHeader["Extract Headers: Authorization, x-secret, user"]
    
    GetHeader --> CheckSecret{"Has x-secret == process.env.X_SECRET?"}
    CheckSecret -->|"Yes"| AllowPrivileged["Grant Access (Admin / Internal Service)"]
    CheckSecret -->|"No"| CheckAuthHeader{"Has Authorization: Bearer <token>?"}
    
    CheckAuthHeader -->|"No"| Deny401["Throw UnauthorizedException('Missing token')"]
    CheckAuthHeader -->|"Yes"| ExtractToken["Parse JWT Token Payload"]
    
    ExtractToken --> ValidateJWT{"Token Valid & Not Expired?"}
    ValidateJWT -->|"No"| DenyInvalid["Throw UnauthorizedException('Invalid or expired token')"]
    ValidateJWT -->|"Yes"| AttachUser["Attach user object to request: req.user = decodedToken"]
    
    AttachUser --> RoleCheck{"Route requires Admin Role?"}
    RoleCheck -->|"Yes, but user is Student"| Deny403["Throw ForbiddenException('Admin access required')"]
    RoleCheck -->|"Role matches requirement"| AllowRequest["Proceed to Controller Action"]
    AllowPrivileged --> AllowRequest
```

---

## 4. Chatbot Conversation & Two-Tier Semantic RAG Execution Flow

The AI Chatbot provides student-specific, hallucination-free answers via a Two-Tier architecture combining deterministic relational context with semantic vector retrieval across pre-indexed Entity Cards.

### 4.1 Two-Tier RAG Message Handling Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Student
    participant ChatCtrl as ChatController (src/modules/chatbot/chat.controller.ts)
    participant ChatSvc as ChatService (src/modules/chatbot/chat.service.ts)
    participant RagSvc as RagService (src/modules/rag/rag.service.ts)
    participant DbSvc as DbService / PostgreSQL (Supabase pgvector)
    participant GeminiEmb as Gemini Embedding API (gemini-embedding-001)
    participant GeminiLLM as Gemini 3.5 Flash API (LLM)

    Student->>ChatCtrl: POST /chat/message { chatId, content: "Where is room 38-702?" }
    ChatCtrl->>ChatSvc: handleMessage(userMessage, chatId)
    
    ChatSvc->>DbSvc: ChatHistoryModel.findByPk(chatId)
    DbSvc-->>ChatSvc: Return Chat Room (userId, title)
    
    ChatSvc->>DbSvc: ChatMessageModel.create({ chatId, role: 'user', content })
    DbSvc-->>ChatSvc: User message saved

    rect rgb(240, 248, 255)
        Note over ChatSvc,DbSvc: TIER 1: Personal Deterministic Context Pruning
        ChatSvc->>DbSvc: CourseService.getUserCourse(userId)
        DbSvc-->>ChatSvc: Enrolled Course (e.g. MCA)
        ChatSvc->>DbSvc: CourseService.getSubjects(courseId)
        Note over ChatSvc: Filter today's timetable slots by current day of week<br/>Extract room, time, subject, teacher
    end

    rect rgb(255, 245, 238)
        Note over ChatSvc,GeminiEmb: TIER 2: Semantic Campus Knowledge Retrieval (RAG)
        ChatSvc->>RagSvc: queryRelevantCards(userMessage, 3)
        RagSvc->>GeminiEmb: POST /models/gemini-embedding-001:embedContent { text: query, outputDim: 768 }
        GeminiEmb-->>RagSvc: 768-dimensional query vector
        RagSvc->>DbSvc: SELECT title, content, 1 - (embedding <=> :vector) as similarity<br/>FROM campus_knowledge_cards ORDER BY embedding <=> :vector ASC LIMIT 3
        DbSvc-->>RagSvc: Top 3 matching Entity Cards (e.g. Block 38 card with Google Maps link)
        RagSvc-->>ChatSvc: Relevant Campus Cards array
    end

    ChatSvc->>DbSvc: ChatMessageModel.findAll({ where: { chatId }, order: [['createdAt', 'ASC']] })
    DbSvc-->>ChatSvc: Previous Conversation History

    rect rgb(245, 255, 245)
        Note over ChatSvc: Prompt Consolidation
        ChatSvc->>ChatSvc: Merge initial guidelines + team attribution + Tier 1 (schedule) + Tier 2 (cards)
    end

    ChatSvc->>GeminiLLM: POST /v1beta/openai/chat/completions { model: 'gemini-3.5-flash', messages }
    GeminiLLM-->>ChatSvc: 200 OK: { choices: [ { message: { content: botReply } } ] }

    ChatSvc->>DbSvc: ChatMessageModel.create({ chatId, role: 'assistant', content: botReply })
    DbSvc-->>ChatSvc: Bot Message Persisted
    ChatSvc-->>ChatCtrl: Return Persisted Bot Message
    ChatCtrl-->>Student: 200 OK: { data: botReply, meta: { success: true } }
```

### 4.2 Entity Cards Sync & Vector Indexing Pipeline

```mermaid
flowchart TD
    Trigger["Application Bootstrap or POST /rag/sync"] --> CheckCount{"campus_knowledge_cards is empty?"}
    CheckCount -->|"No and not manual sync"| Skip["Skip (Index already active)"]
    CheckCount -->|"Yes or manual sync"| FetchEntities["Fetch Relational Tables:<br/>- Faculties<br/>- Buildings & Coordinates<br/>- Subjects & Timetables<br/>- Events<br/>- Degree Programs"]

    FetchEntities --> BuildMarkdown["Transform into Modular Markdown Entity Cards:<br/>- # Faculty Profile: Name, Email, Phone, Subjects<br/>- # Campus Location: Name, Lat/Lng, Google Maps link, Rooms<br/>- # Subject Curriculum: Program, Teacher, Weekly Schedule<br/>- # Campus Event: Date/Time, Venue, Details"]

    BuildMarkdown --> BatchEmbed["RagService.batchGenerateEmbeddings()<br/>gemini-embedding-001 (dim: 768) in batches of 40"]
    BatchEmbed --> PgVectorUpsert["Upsert into campus_knowledge_cards with ON CONFLICT (entityType, entityId)"]
    PgVectorUpsert --> HNSWIndex["HNSW Vector Index (vector_cosine_ops) updated"]
    HNSWIndex --> Done["✅ 36+ Entity Cards Ready for Sub-Second Semantic Retrieval"]
```

---

## 5. Academic Course & Timetable Management Flow

### 5.1 Student Course Enrollment & Timetable Resolution

```mermaid
flowchart TD
    StartEnroll["Student selects Course on UI"] --> PostJoin["POST /education/course/join { courseId }"]
    PostJoin --> JoinService["CoursesService.joinCourse(userId, courseId)"]
    
    JoinService --> CheckExisting{"StudentCourseModel.findOne(userId, courseId)"}
    CheckExisting -->|"Already Enrolled"| ReturnCurrent["Return existing enrollment"]
    CheckExisting -->|"Not Enrolled"| CreateEnroll["StudentCourseModel.create(userId, courseId)"]
    
    CreateEnroll --> ReturnJoined["201 Created: Course Joined Successfully"]
    
    ReturnJoined --> ReqTimetable["Student navigates to /timetable"]
    ReqTimetable --> GetTimetable["GET /education/course-timetable?courseId=..."]
    GetTimetable --> QuerySlots["CoursesService.getCourseTimeTable(courseId)"]
    
    QuerySlots --> RelationalFetch["Sequelize Query with Associations:<br/>- TimetableSlotModel<br/>- Include SubjectModel<br/>- Include FacultyModel<br/>- Include BuildingModel"]
    
    RelationalFetch --> SortDays["Sort by Day of Week (Monday -> Saturday) & Start Time"]
    SortDays --> ReturnSchedule["200 OK: Complete Weekly Schedule with Room Locations"]
```

### 5.2 Admin Course & Complete Timetable Creation

```mermaid
flowchart TD
    Admin["Admin User"] --> SubmitCourse["POST /education/courses { name, code, description }"]
    SubmitCourse --> CreateCourse["CoursesService.createCourse()"]
    CreateCourse --> CourseDB[("CoursesModel.create()")]
    CourseDB --> CourseCreated["Course ID Generated"]

    CourseCreated --> SubmitSubjects["POST /education/subjects { name, code, courseId, credits }"]
    SubmitSubjects --> CreateSubjects["CoursesService.createSubject()"]
    CreateSubjects --> SubjectDB[("SubjectModel.create()")]

    SubjectDB --> SubmitSchedule["POST /education/complete-timetable { courseId, slots: [...] }"]
    SubmitSchedule --> ProcessSlots["CoursesService.createCompleteTimeTable()"]
    
    ProcessSlots --> LoopSlots["For each slot:<br/>Validate Subject, Faculty, Building foreign keys"]
    LoopSlots --> BulkInsert[("TimetableSlotModel.bulkCreate(validatedSlots)")]
    BulkInsert --> TimetableReady["201 Created: Full Academic Timetable Deployed"]
```

---

## 6. Campus Building & Navigation Geolocation Flow

Campus buildings are mapped with geographic coordinates and Google Maps directions to empower the AI assistant and interactive directory to navigate students across campus.

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    participant BuildingCtrl as BuildingController (src/modules/building/building.controller.ts)
    participant BuildingSvc as BuildingService (src/modules/building/building.service.ts)
    participant BuildingModel as BuildingModel (PostgreSQL)

    Admin->>BuildingCtrl: POST /building { name, code, latitude, longitude, description, mapUrl }
    BuildingCtrl->>BuildingSvc: createBuilding(dto)
    BuildingSvc->>BuildingModel: findOne({ where: { code } })
    
    alt Building Code Exists
        BuildingModel-->>BuildingSvc: Existing Record
        BuildingSvc-->>BuildingCtrl: Throw BadRequestException('Building code already exists')
        BuildingCtrl-->>Admin: 400 Bad Request
    else Unique Building Code
        BuildingSvc->>BuildingModel: create({ name, code, coordinates, mapUrl })
        BuildingModel-->>BuildingSvc: Building Record Created
        BuildingSvc-->>BuildingCtrl: Return Building Entity
        BuildingCtrl-->>Admin: 201 Created: { data: building, meta: { success: true } }
    end
```

---

## 7. Administrative Dashboard Aggregation Flow

The admin dashboard aggregates institutional data in real time to present enrollment KPIs, faculty counts, and academic distributions.

```mermaid
flowchart TD
    Req["GET /dashboard/admin"] --> DashCtrl["DashboardController.admin()"]
    DashCtrl --> DashSvc["DashboardService.getAdminDashboard()"]
    
    subgraph Parallel_DB_Queries["Parallel Aggregation via Promise.all"]
        DashSvc --> Q1["StudentCourseModel.count({ distinct: true, col: 'userId' })"]
        DashSvc --> Q2["FacultyModel.count()"]
        DashSvc --> Q3["CourseModel.count()"]
        DashSvc --> Q4["BuildingModel.count()"]
        DashSvc --> Q5["StudentCourseModel.findAll({ limit: 5, order: [['createdAt', 'DESC']] })"]
        DashSvc --> Q6["EventModel.findAll({ where: { date >= NOW() }, limit: 5 })"]
    end
    
    Q1 --> Assemble["Aggregate Metrics into Structured KPI DTO"]
    Q2 --> Assemble
    Q3 --> Assemble
    Q4 --> Assemble
    Q5 --> Assemble
    Q6 --> Assemble
    
    Assemble --> ResEnvelope["ReqResInterceptor Envelope Wrapping"]
    ResEnvelope --> ReturnDash["200 OK: { totalStudents, totalFaculty, totalCourses, totalBuildings, recentEnrollments, upcomingEvents }"]
```

---

## 8. Database Connection & Remote SSL Handshake

```mermaid
flowchart TD
    StartDB["SqlService Constructor Called with URI"] --> ParseURI["Parse Database Connection String"]
    ParseURI --> CheckHost{"Is Host Remote? (not localhost / 127.0.0.1)"}
    
    CheckHost -->|"Yes (e.g. pooler.supabase.com)"| ConfigSSL["dialectOptions = { ssl: { require: true, rejectUnauthorized: false } }"]
    CheckHost -->|"No (Local PostgreSQL)"| ConfigPlain["dialectOptions = {}"]
    
    ConfigSSL --> InitSequelize["Instantiate Sequelize(uri, dialectOptions)"]
    ConfigPlain --> InitSequelize
    
    InitSequelize --> LoadModels["Iterate SQL_MODELS: Pass sequelize instance to each model initFn"]
    LoadModels --> AssociateModels["Iterate models: Invoke model.associate(allModels)"]
    
    AssociateModels --> OnModuleInit["DbService.onModuleInit() triggers sqlConnection.init()"]
    OnModuleInit --> Authenticate["sequelize.authenticate()"]
    
    Authenticate --> AuthSuccess{"Authentication Successful?"}
    AuthSuccess -->|"Yes"| DBReady["Log: ✅ Successfully connected to PostgreSQL!"]
    
    AuthSuccess -->|"No"| CheckEnv{"Is process.env.VERCEL active?"}
    CheckEnv -->|"Yes (Serverless)"| LogWarn["Log Error: ❌ Failed to connect to DB.<br/>Do NOT throw or exit process.<br/>Allow app to serve healthcheck and diagnostic errors."]
    CheckEnv -->|"No (Local Development)"| CrashLocal["Log Error: ❌ Failed to connect to DB.<br/>process.exit(1) & throw err"]
```

---

## 9. Global Error Shielding & Exception Filter Flow

```mermaid
flowchart TD
    ErrorThrown["Exception Thrown Anywhere in Pipeline"] --> CatchFilter["HttpExceptionFilter.catch(exception, host)"]
    
    CatchFilter --> InspectType{"Is exception instanceof HttpException?"}
    
    InspectType -->|"Yes"| ExtractStatus["status = exception.getStatus()"]
    ExtractStatus --> ExtractResponse["responsePayload = exception.getResponse()"]
    
    InspectType -->|"No (Unhandled Error, e.g. DB crash)"| Set500["status = HttpStatus.INTERNAL_SERVER_ERROR (500)"]
    Set500 --> SanitizeMsg["message = 'Internal server error'"]
    
    ExtractResponse --> BuildEnvelope["Construct Standard Error Envelope"]
    SanitizeMsg --> BuildEnvelope
    
    BuildEnvelope --> EnvelopeStructure["Payload:<br/>{<br/>  data: null,<br/>  meta: {<br/>    success: false,<br/>    message: errorMessage,<br/>    failures: detailedFailures<br/>  }<br/>}"]
    
    EnvelopeStructure --> LogError["LoggerService.error(requestDetails, exceptionStack)"]
    LogError --> SendResponse["res.status(status).json(envelope)"]
```
