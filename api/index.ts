import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app/api/app.module';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { LoggerInterceptor } from '../src/core/services/logger/logger.interceptor';
import { LoggerService } from '../src/core/services/logger/logger.service';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import express = require('express');

let cachedServer: express.Express;

async function bootstrapServer(): Promise<express.Express> {
  if (!cachedServer) {
    const expressApp = express();
    const app = await NestFactory.create(
      AppModule,
      new ExpressAdapter(expressApp),
    );
    const loggerService = app.get(LoggerService);

    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        forbidUnknownValues: false,
      }),
    );

    app.enableCors();
    app.useGlobalInterceptors(new LoggerInterceptor(loggerService));

    const config = new DocumentBuilder()
      .setTitle('Campus GPT backend')
      .setDescription('The API description')
      .setVersion('1.0')
      .build();
    const documentFactory = () => SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, documentFactory);

    await app.init();
    cachedServer = expressApp;
  }
  return cachedServer;
}

export default async function handler(req: any, res: any) {
  const server = await bootstrapServer();
  return server(req, res);
}
