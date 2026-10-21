// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheckService } from '@nestjs/terminus';
import { CustomHealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private readonly customHealthService: CustomHealthService,
  ) {}

  @Get()
  root() {
    return {
      status: 'ok',
      message: 'Campus GPT Backend API is running',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health')
  check() {
    return this.health.check([
      () => this.customHealthService.checkSqlConnection(),
      // () => this.customHealthService.checkMongoConnection(),
    ]);
  }
}
