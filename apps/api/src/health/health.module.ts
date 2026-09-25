import { Module } from '@nestjs/common';
import { AdminHealthController } from './health.controller';
import { HealthMonitor } from './health-monitor';
import { garageSpaceProbe, HealthService, SPACE_PROBE } from './health.service';

@Module({
  controllers: [AdminHealthController],
  providers: [HealthService, HealthMonitor, { provide: SPACE_PROBE, useValue: garageSpaceProbe }],
  exports: [HealthService],
})
export class SystemHealthModule {}
