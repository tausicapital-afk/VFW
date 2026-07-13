import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingGateway } from './messaging.gateway';
import { MessagingService } from './messaging.service';

/**
 * Messaging. StorageService (R2) is @Global, PrismaService is @Global and
 * JwtModule is registered global in AppModule, so nothing extra is imported.
 *
 * There is deliberately no circular dependency: the gateway depends on the
 * service, the controller depends on both, and the service depends on neither.
 * Fan-out is driven from the controller after the service has persisted.
 */
@Module({
  controllers: [MessagingController],
  providers: [MessagingService, MessagingGateway],
})
export class MessagingModule {}
