import { Controller, Get, Post, Query } from '@nestjs/common';
import { RagService } from './rag.service';

@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Post('sync')
  async syncCards() {
    return await this.ragService.syncEntityCards();
  }

  @Get('search')
  async search(@Query('q') q: string, @Query('limit') limit?: string) {
    const numLimit = limit ? parseInt(limit, 10) : 3;
    return await this.ragService.queryRelevantCards(q || '', numLimit);
  }
}
