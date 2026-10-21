const { NestFactory } = require('@nestjs/core');
const { ExpressAdapter } = require('@nestjs/platform-express');
const express = require('express');

let cachedServer;

async function bootstrapServer() {
  if (!cachedServer) {
    const { AppModule } = require('../dist/app/api/app.module');
    const { ValidationPipe } = require('@nestjs/common');
    const { LoggerInterceptor } = require('../dist/core/services/logger/logger.interceptor');
    const { LoggerService } = require('../dist/core/services/logger/logger.service');

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

    try {
      const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
      const config = new DocumentBuilder()
        .setTitle('Campus GPT backend')
        .setDescription('The API description')
        .setVersion('1.0')
        .build();
      const documentFactory = () => SwaggerModule.createDocument(app, config);
      SwaggerModule.setup('api/docs', app, documentFactory);
    } catch (e) {
      console.warn('Swagger setup skipped:', e?.message);
    }

    await app.init();
    cachedServer = expressApp;
  }
  return cachedServer;
}

async function handler(req, res) {
  try {
    const server = await bootstrapServer();

    // Normalize URL if prefixed with /api (except Swagger docs at /api/docs)
    if (req.url === '/api' || req.url === '/api/') {
      req.url = '/';
    } else if (req.url.startsWith('/api/') && !req.url.startsWith('/api/docs')) {
      req.url = req.url.replace(/^\/api/, '');
    }

    return server(req, res);
  } catch (err) {
    console.error('SERVERLESS_INVOCATION_ERROR:', err);
    return res.status(500).json({
      statusCode: 500,
      error: 'FUNCTION_INITIALIZATION_ERROR',
      message: err?.message || 'Serverless initialization failed',
      stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack,
    });
  }
}

module.exports = handler;
module.exports.default = handler;
