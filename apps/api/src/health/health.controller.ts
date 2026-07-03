import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Public()
@Controller()
export class HealthController {
  @Get()
  root() {
    return { name: 'AgentFlow API', status: 'ok', milestone: 'M0' };
  }

  @Get('health')
  health() {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
