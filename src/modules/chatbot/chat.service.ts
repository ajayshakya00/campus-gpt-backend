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

@Injectable()
export class ChatService {
  private readonly OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  private readonly OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;
  private readonly OPENROUTER_URL = process.env.OPENROUTER_URL!;
  private readonly ChatMessageModel: typeof ChatMessageModel;
  private readonly ChatHistoryModel: typeof ChatHistoryModel;
  constructor(
    private readonly dbService: DbService,
    private readonly courseService: CourseService,
    private readonly facultyService: FacultyService,
    private readonly buildingService: BuildingService,
    private readonly eventService: EventService,
  ) {
    this.ChatMessageModel = this.dbService.sqlService.ChatMessageModel;
    this.ChatHistoryModel = this.dbService.sqlService.ChatHistoryModel;
  }

  private async getModelTrainingData(userId: string) {
    const data = [
      ...INITIAL_MODEL_DATA.map((content) => ({
        role: 'system',
        content,
      })),
    ];
    try {
      const course = await this.courseService.getUserCourse(userId);
      data.push({
        role: 'system',
        content: `I am enrolled in this course: ${JSON.stringify(course)}`,
      });
    } catch (err) {
      console.log(err);
    }

    const faculties = await this.facultyService.findAll();
    data.push({
      role: 'system',
      content: `these are my universities faculties : ${JSON.stringify(faculties)}`,
    });

    const subjects = await this.courseService.getSubjects();
    data.push({
      role: 'system',
      content: `these are my universities subjects with their timetable : ${JSON.stringify(subjects)}`,
    });

    const buildings = await this.buildingService.getAllBuildings();
    data.push({
      role: 'system',
      content: `these are my universities buildings with their locations : ${JSON.stringify(buildings)} \n\n when i ask for location then give me the google map link with these coordinates. for example i ask for my class location and room matches with the building then give the that perticular building location`,
    });

    const events = await this.eventService.getEvents();
    data.push({
      role: 'system',
      content: `these are the university events details : ${JSON.stringify(events)}`,
    });

    console.log({ data });

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
    console.log('chat id: ', chatId);

    const room = await this.getChatRoomById(chatId);

    console.log('chat id 2: ', chatId);

    await this.ChatMessageModel.create({
      chatId,
      role: 'user',
      content: userMessage,
    });

    console.log('chat id 3: ', chatId);

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

    console.log({ room });

    const trainingData = await this.getModelTrainingData(room.userId);

    console.log({ trainingData });

    // Convert DB history to OpenAI-compatible format
    const formattedMessages = [
      ...trainingData,
      ...history.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    // Send to OpenRouter API
    //
    try {
      const response = await axios.post(
        this.OPENROUTER_URL,
        {
          model: this.OPENROUTER_MODEL,
          messages: formattedMessages,
        },
        {
          headers: {
            Authorization: `Bearer ${this.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        },
      );

      console.log({ response });

      const botReply = response.data.choices[0].message.content;

      // Save bot reply to DB
      return await this.ChatMessageModel.create({
        chatId,
        role: 'assistant',
        content: botReply,
      });
    } catch (err: any) {
      console.log(err);
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
