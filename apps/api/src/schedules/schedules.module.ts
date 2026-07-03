import { Module } from '@nestjs/common';
import { SchedulesService } from './schedules.service';
import { SchedulesController, ScheduleAdminController } from './schedules.controller';
import { SCHEDULE_QUEUE, createScheduleQueue } from '../execution/queue';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [SchedulesController, ScheduleAdminController],
  providers: [SchedulesService, { provide: SCHEDULE_QUEUE, useFactory: createScheduleQueue }],
})
export class SchedulesModule {}
