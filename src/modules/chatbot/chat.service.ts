// src/chat/chat.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { DbService } from 'src/core/services/db-service/db.service';
import { ChatHistoryModel, ChatMessageModel } from './chat.schema';
import { CreateChatSessionDto } from './chat.dto';
import { ASSISTANCE_GREETING, INITIAL_MODEL_DATA } from './chat.constants';
import { CourseService } from '../courses/courses.services';
import { FacultyService } from '../faculty/faculty.services';
import { BuildingService } from '../building/building.service';
import * as pdfParse from 'pdf-parse';
import { EventService } from '../events/events.services';
import { RagService } from '../rag/rag.service';

@Injectable()
export class ChatService {
  private readonly GEMINI_API_KEY =
    process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY;
  private readonly GEMINI_MODEL =
    process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  private readonly GEMINI_URL =
    process.env.GEMINI_URL ||
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  private readonly ChatMessageModel: typeof ChatMessageModel;
  private readonly ChatHistoryModel: typeof ChatHistoryModel;
  constructor(
    private readonly dbService: DbService,
    private readonly courseService: CourseService,
    private readonly facultyService: FacultyService,
    private readonly buildingService: BuildingService,
    private readonly eventService: EventService,
    private readonly ragService: RagService,
  ) {
    this.ChatMessageModel = this.dbService.sqlService.ChatMessageModel;
    this.ChatHistoryModel = this.dbService.sqlService.ChatHistoryModel;
  }

  private async getModelTrainingData(userId: string, userMessage: string) {
    const data: Array<{ role: string; content: string }> = [
      ...INITIAL_MODEL_DATA.map((content) => ({
        role: 'system',
        content,
      })),
    ];

    // ==========================================
    // TIER 1: Personal Deterministic Context
    // ==========================================
    try {
      const course = await this.courseService.getUserCourse(userId);
      if (course) {
        const todayDay = new Date().toLocaleDateString('en-US', {
          weekday: 'long',
        });
        const enrolledSubjects = await this.courseService.getSubjects(course.id);

        const todaySlots: Array<{
          subject: string;
          startTime: string;
          endTime: string;
          room: string;
          teacher: string;
        }> = [];

        for (const sub of enrolledSubjects) {
          const s = (sub.dataValues || sub) as any;
          const slots = (s.timetables || []).filter(
            (t: any) =>
              (t.day || t.dataValues?.day)?.toLowerCase() ===
              todayDay.toLowerCase(),
          );
          for (const slot of slots) {
            const val = slot.dataValues || slot;
            todaySlots.push({
              subject: s.name,
              startTime: val.startTime,
              endTime: val.endTime,
              room: val.room || 'TBD',
              teacher: s.teacher?.name || 'Assigned Instructor',
            });
          }
        }

        todaySlots.sort((a, b) => a.startTime.localeCompare(b.startTime));

        const studentProfile = [
          `### Student Profile & Schedule:`,
          `- **Enrolled Program**: ${course.name} (${course.code})`,
          `- **Today**: ${todayDay}`,
          `- **Classes Today (${todayDay})**:`,
          todaySlots.length > 0
            ? todaySlots
                .map(
                  (t) =>
                    `  * ${t.startTime} - ${t.endTime}: **${t.subject}** in Room **${t.room}** (Faculty: ${t.teacher})`,
                )
                .join('\n')
            : '  * No classes scheduled for today.',
          `- **Enrolled Subjects**: ${enrolledSubjects
            .map((s) => s.dataValues?.name || s.name)
            .join(', ')}`,
        ].join('\n');

        data.push({
          role: 'system',
          content: studentProfile,
        });
      } else {
        data.push({
          role: 'system',
          content:
            'Student Status: Not enrolled in any course program yet. Prompt them to select their program (MCA/BCA) if they ask for personal schedules.',
        });
      }
    } catch (err) {
      console.error('Error fetching Tier 1 personal context:', err);
    }

    // ==========================================
    // TIER 2: Semantic Campus Knowledge (RAG)
    // ==========================================
    try {
      const relevantCards = await this.ragService.queryRelevantCards(
        userMessage,
        3,
      );

      if (relevantCards && relevantCards.length > 0) {
        const cardsText = relevantCards
          .map(
            (card, idx) =>
              `--- Card ${idx + 1}: ${card.title} ---\n${card.content}`,
          )
          .join('\n\n');

        data.push({
          role: 'system',
          content: `### Relevant Campus Knowledge:\n${cardsText}\n\nNote: If asked for directions or locations, always use the Google Maps navigation links provided in the cards above.`,
        });
      }
    } catch (err) {
      console.error('Error retrieving Tier 2 RAG context:', err);
    }

    return data;
  }

  async getChatRoomById(id: string) {
    const room = await this.ChatHistoryModel.findByPk(id);

    if (!room) throw new NotFoundException('Room does not exists');

    console.log({ initial: room });

    return room?.dataValues;
  }

  async handleMessage(
    userMessage: string,
    chatId: string,
    file?: Express.Multer.File,
  ) {
    const room = await this.getChatRoomById(chatId);

    await this.ChatMessageModel.create({
      chatId,
      role: 'user',
      content: userMessage,
    });

    if (file) {
      const pdfData = await pdfParse(file.buffer);
      await this.ChatMessageModel.create({
        chatId,
        role: 'system',
        content: `The user uploaded a PDF file. Content:\n\n${pdfData?.text ?? ''}`,
      });
    }

    const history = await this.ChatMessageModel.findAll({
      where: { chatId },
      order: [['createdAt', 'ASC']],
    });

    const trainingData = await this.getModelTrainingData(
      room.userId,
      userMessage,
    );

    // Combine all system messages into a single system prompt
    // (Gemini's OpenAI compatibility endpoint overwrites earlier system messages if sent separately)
    const systemContents = [
      ...trainingData.map((msg) => msg.content),
      ...history
        .filter((msg) => (msg.role ?? msg.dataValues?.role) === 'system')
        .map((msg) => msg.content ?? msg.dataValues?.content),
    ];

    const formattedMessages = [
      {
        role: 'system',
        content: systemContents.join('\n\n'),
      },
      ...history
        .filter((msg) => (msg.role ?? msg.dataValues?.role) !== 'system')
        .map((msg) => ({
          role: msg.role ?? msg.dataValues?.role,
          content: msg.content ?? msg.dataValues?.content,
        })),
    ];

    // Send to Gemini API
    try {
      let response;
      try {
        response = await axios.post(
          this.GEMINI_URL,
          {
            model: this.GEMINI_MODEL,
            messages: formattedMessages,
          },
          {
            headers: {
              Authorization: `Bearer ${this.GEMINI_API_KEY}`,
              'Content-Type': 'application/json',
            },
          },
        );
      } catch (primaryErr: any) {
        if (this.GEMINI_MODEL !== 'gemini-3.5-flash') {
          response = await axios.post(
            this.GEMINI_URL,
            {
              model: 'gemini-3.5-flash',
              messages: formattedMessages,
            },
            {
              headers: {
                Authorization: `Bearer ${this.GEMINI_API_KEY}`,
                'Content-Type': 'application/json',
              },
            },
          );
        } else {
          throw primaryErr;
        }
      }

      const botReply = response.data.choices[0].message.content;

      // Save bot reply to DB
      return await this.ChatMessageModel.create({
        chatId,
        role: 'assistant',
        content: botReply,
      });
    } catch (err: any) {
      console.log(err?.response?.data || err);
      return new BadRequestException('someting went worong');
    }
  }

  async createChatSession(data: CreateChatSessionDto, userId: string) {
    const res = await this.ChatHistoryModel.create({
      title: data.title || 'New Chat',
      userId,
    });

    await this.ChatMessageModel.create({
      chatId: res.dataValues.id,
      role: 'assistant',
      content: ASSISTANCE_GREETING,
    });

    return res.dataValues;
  }

  async getChatMessages(chatId: string) {
    console.log({ chatId });

    return this.ChatMessageModel.findAll({
      where: { chatId },
      order: [['createdAt', 'ASC']],
    });
  }

  async getChatHistory(userId: string) {
    return this.ChatHistoryModel.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
    });
  }

  async deleteChatHistory(id: string) {
    return this.ChatHistoryModel.destroy({ where: { id } });
  }
}
