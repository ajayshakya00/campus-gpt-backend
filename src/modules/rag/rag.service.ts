import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import axios from 'axios';
import { QueryTypes } from 'sequelize';
import { DbService } from 'src/core/services/db-service/db.service';

export interface RetrievedCard {
  title: string;
  content: string;
  entityType: string;
  entityId: string;
  similarity: number;
}

interface CardPayload {
  entityType: string;
  entityId: string;
  title: string;
  content: string;
  metadata: Record<string, any>;
}

@Injectable()
export class RagService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RagService.name);
  private readonly GEMINI_API_KEY =
    process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY;

  constructor(private readonly dbService: DbService) {}

  async onApplicationBootstrap() {
    try {
      const sequelize = this.dbService.getSqlConnection().getSequelizeInstance();
      const countRes: any[] = await sequelize.query(
        'SELECT count(*)::int as count FROM campus_knowledge_cards;',
        { type: QueryTypes.SELECT },
      );
      const count = countRes?.[0]?.count || 0;
      if (count === 0) {
        this.logger.log('⚡ No knowledge cards found. Running initial sync...');
        await this.syncEntityCards();
      } else {
        this.logger.log(`✅ Campus Knowledge Cards ready: ${count} entities indexed.`);
      }
    } catch (err: any) {
      this.logger.warn('Error during RAG bootstrap check:', err?.message || err);
    }
  }

  /**
   * Generate 768-dimensional embedding for a single text using Gemini
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    const cleanText = text.trim().slice(0, 4000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${this.GEMINI_API_KEY}`;

    const res = await axios.post(url, {
      model: 'models/gemini-embedding-001',
      content: {
        parts: [{ text: cleanText }],
      },
      outputDimensionality: 768,
    });

    return res.data?.embedding?.values || [];
  }

  /**
   * Batch generate embeddings for multiple texts (up to 50 per batch)
   */
  async batchGenerateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    if (texts.length === 0) return [];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${this.GEMINI_API_KEY}`;
    const batchSize = 40;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize);
      const requests = slice.map((t) => ({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: t.trim().slice(0, 4000) }] },
        outputDimensionality: 768,
      }));

      const res = await axios.post(url, { requests });
      const embeddings = res.data?.embeddings || [];
      for (const emb of embeddings) {
        allEmbeddings.push(emb.values);
      }
    }

    return allEmbeddings;
  }

  /**
   * Synchronize all relational database entities (Faculties, Buildings, Subjects, Events, Courses)
   * into rich, human-readable Markdown Entity Cards with pgvector embeddings.
   */
  async syncEntityCards(): Promise<{ synced: number }> {
    this.logger.log('🔄 Building and indexing Campus Entity Cards...');
    const sequelize = this.dbService.getSqlConnection().getSequelizeInstance();
    const sql = this.dbService.sqlService;

    const cards: CardPayload[] = [];

    // 1. Index Faculties
    const faculties = await sql.FacultyModel.findAll();
    const subjects = await sql.SubjectModel.findAll();

    for (const fac of faculties) {
      const f = fac.dataValues;
      const taughtSubjects = subjects
        .filter((s) => s.dataValues.teacherId === f.id)
        .map((s) => s.dataValues.name);

      const content = [
        `# Faculty Profile: ${f.name}`,
        `- **Designation**: ${f.designation || 'Faculty Member'}`,
        `- **Email**: ${f.email}`,
        `- **Phone**: ${f.phone || 'N/A'}`,
        `- **Subjects Taught**: ${
          taughtSubjects.length > 0 ? taughtSubjects.join(', ') : 'General Faculty'
        }`,
      ].join('\n');

      cards.push({
        entityType: 'faculty',
        entityId: f.id,
        title: `Faculty: ${f.name} (${f.designation || 'Faculty'})`,
        content,
        metadata: {
          facultyId: f.id,
          name: f.name,
          email: f.email,
          designation: f.designation,
        },
      });
    }

    // 2. Index Buildings / Campus Locations
    const buildings = await sql.BuildingModel.findAll();
    for (const bldg of buildings) {
      const b = bldg.dataValues;
      const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${b.latitude},${b.longitude}`;

      const content = [
        `# Campus Location: ${b.name}`,
        `- **Description / Enclosed Rooms**: ${
          b.description || 'Academic campus facility'
        }`,
        `- **Coordinates**: Latitude ${b.latitude}, Longitude ${b.longitude}`,
        `- **Google Maps Navigation**: [Open ${b.name} on Google Maps](${mapsUrl})`,
      ].join('\n');

      cards.push({
        entityType: 'building',
        entityId: b.id,
        title: `Campus Location: ${b.name}`,
        content,
        metadata: {
          buildingId: b.id,
          name: b.name,
          latitude: b.latitude,
          longitude: b.longitude,
          mapsUrl,
        },
      });
    }

    // 3. Index Subjects with Timetables & Assigned Teacher
    const courses = await sql.CoursesModel.findAll();
    const timetables = await sql.TimetableModel.findAll();

    for (const sub of subjects) {
      const s = sub.dataValues;
      const course = courses.find((c) => c.dataValues.id === s.courseId)?.dataValues;
      const teacher = faculties.find((f) => f.dataValues.id === s.teacherId)?.dataValues;
      const subjectSlots = timetables
        .filter((t) => t.dataValues.subjectId === s.id && t.dataValues.day)
        .map((t) => t.dataValues);

      const slotLines =
        subjectSlots.length > 0
          ? subjectSlots.map(
              (slot) =>
                `  - **${slot.day}**: ${slot.startTime} to ${slot.endTime} in Room ${
                  slot.room || 'TBD'
                }`,
            )
          : ['  - Class schedule details to be announced'];

      const content = [
        `# Subject Curriculum: ${s.name}`,
        `- **Academic Program**: ${course?.name || 'General Course'} (${
          course?.code || ''
        })`,
        `- **Faculty In Charge**: ${
          teacher
            ? `${teacher.name} (${teacher.designation || 'Instructor'})`
            : 'To be announced'
        }`,
        `- **Faculty Email**: ${teacher?.email || 'N/A'}`,
        `- **Weekly Lecture Timetable**:`,
        ...slotLines,
      ].join('\n');

      cards.push({
        entityType: 'subject',
        entityId: s.id,
        title: `Subject: ${s.name} (${course?.name || 'Course'})`,
        content,
        metadata: {
          subjectId: s.id,
          courseId: s.courseId,
          teacherId: s.teacherId,
          name: s.name,
        },
      });
    }

    // 4. Index Events
    const events = await sql.EventModel.findAll();
    for (const ev of events) {
      const e = ev.dataValues;
      const eventDate = e.time
        ? new Date(e.time).toLocaleString('en-US', {
            dateStyle: 'full',
            timeStyle: 'short',
          })
        : 'Date to be announced';

      const content = [
        `# Campus Event: ${e.name}`,
        `- **Date & Time**: ${eventDate}`,
        `- **Location / Venue**: ${e.location}`,
        `- **Event Details**: ${e.description}`,
      ].join('\n');

      cards.push({
        entityType: 'event',
        entityId: e.id,
        title: `Campus Event: ${e.name}`,
        content,
        metadata: {
          eventId: e.id,
          name: e.name,
          location: e.location,
          time: e.time,
        },
      });
    }

    // 5. Index Courses Summary
    for (const crs of courses) {
      const c = crs.dataValues;
      const subjectsInCourse = subjects
        .filter((s) => s.dataValues.courseId === c.id)
        .map((s) => s.dataValues.name);

      const content = [
        `# Degree Program: ${c.name} (${c.code})`,
        `- **Program Code**: ${c.code}`,
        `- **Core Subjects**: ${
          subjectsInCourse.length > 0
            ? subjectsInCourse.join(', ')
            : 'Curriculum being finalized'
        }`,
      ].join('\n');

      cards.push({
        entityType: 'course',
        entityId: c.id,
        title: `Program: ${c.name} (${c.code})`,
        content,
        metadata: {
          courseId: c.id,
          code: c.code,
          name: c.name,
        },
      });
    }

    this.logger.log(`Generated ${cards.length} Entity Cards. Generating embeddings...`);

    const textsToEmbed = cards.map(
      (c) => `${c.title}\n${c.content}`,
    );

    const embeddings = await this.batchGenerateEmbeddings(textsToEmbed);

    this.logger.log(`Upserting ${cards.length} cards with embeddings into pgvector...`);

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const embedding = embeddings[i];
      if (!embedding || embedding.length === 0) continue;

      const vectorStr = `[${embedding.join(',')}]`;

      await sequelize.query(
        `INSERT INTO campus_knowledge_cards (
           id, "entityType", "entityId", title, content, metadata, embedding, "createdAt", "updatedAt"
         )
         VALUES (
           gen_random_uuid(), :entityType, :entityId, :title, :content, :metadata::jsonb, :embedding::vector, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )
         ON CONFLICT ("entityType", "entityId")
         DO UPDATE SET
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           "updatedAt" = CURRENT_TIMESTAMP;`,
        {
          replacements: {
            entityType: card.entityType,
            entityId: card.entityId,
            title: card.title,
            content: card.content,
            metadata: JSON.stringify(card.metadata),
            embedding: vectorStr,
          },
          type: QueryTypes.UPSERT,
        },
      );
    }

    this.logger.log(`✅ Successfully synced and indexed ${cards.length} Campus Entity Cards.`);
    return { synced: cards.length };
  }

  /**
   * Retrieve the top-K most relevant entity cards via cosine distance in pgvector
   */
  async queryRelevantCards(
    query: string,
    limit = 3,
  ): Promise<RetrievedCard[]> {
    try {
      const queryEmbedding = await this.generateEmbedding(query);
      if (!queryEmbedding || queryEmbedding.length === 0) return [];

      const vectorStr = `[${queryEmbedding.join(',')}]`;
      const sequelize = this.dbService.getSqlConnection().getSequelizeInstance();

      const results: any[] = await sequelize.query(
        `SELECT
           title,
           content,
           "entityType",
           "entityId",
           (1 - (embedding <=> :vector::vector)) AS similarity
         FROM campus_knowledge_cards
         ORDER BY embedding <=> :vector::vector ASC
         LIMIT :limit;`,
        {
          replacements: {
            vector: vectorStr,
            limit,
          },
          type: QueryTypes.SELECT,
        },
      );

      return results.map((r) => ({
        title: r.title,
        content: r.content,
        entityType: r.entityType,
        entityId: r.entityId,
        similarity: parseFloat(r.similarity),
      }));
    } catch (err: any) {
      this.logger.error('Error querying relevant cards:', err?.message || err);
      return [];
    }
  }
}
