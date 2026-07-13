import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../common/auth.guard';
import {
  AddParticipantsDto,
  CreateConversationDto,
  MessagesQueryDto,
  PresignAttachmentDto,
  ReadDto,
  RenameConversationDto,
  SendMessageDto,
} from './dto';
import { MessagingGateway } from './messaging.gateway';
import { MessagingService } from './messaging.service';

/**
 * REST surface for messaging. Every route is guarded by `messaging.use` (which
 * every role holds) plus the per-conversation membership check inside the
 * service — a non-member gets 404, the project's existence-hiding boundary.
 *
 * The durable side (history, sending, media) is REST; the live side (typing,
 * presence, receipts) is the gateway. A sent message is persisted here and then
 * fanned out over the socket.
 */
@Controller('api/messaging')
@Can('messaging.use')
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly gateway: MessagingGateway,
  ) {}

  /** Annotate participants with live online status from the gateway. */
  private withPresence<T extends { participants: { user: { id: string } }[] }>(conversation: T) {
    return {
      ...conversation,
      participants: conversation.participants.map((p) => ({
        ...p,
        online: this.gateway.isOnline(p.user.id),
      })),
    };
  }

  @Get('users')
  async users(@CurrentUser() user: AuthUser) {
    const users = await this.messaging.listUsers(user);
    return users.map((u) => ({ ...u, online: this.gateway.isOnline(u.id) }));
  }

  @Get('conversations')
  async conversations(@CurrentUser() user: AuthUser) {
    const list = await this.messaging.listConversations(user);
    return list.map((c) => this.withPresence(c));
  }

  @Post('conversations')
  async create(@Body() dto: CreateConversationDto, @CurrentUser() user: AuthUser) {
    const { conversation, created } = await this.messaging.createConversation(user, dto);
    if (created) {
      const ids = conversation.participants.map((p) => p.userId);
      await this.gateway.dispatchConversation(conversation, ids);
    }
    return { conversation: this.withPresence(conversation), created };
  }

  @Get('conversations/:id')
  async conversation(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.withPresence(await this.messaging.getConversation(id, user));
  }

  @Get('conversations/:id/messages')
  messages(
    @Param('id') id: string,
    @Query() query: MessagesQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messaging.listMessages(id, user, { before: query.before, limit: query.limit });
  }

  @Post('conversations/:id/messages')
  async send(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { message, recipientIds } = await this.messaging.sendMessage(id, user, dto);
    await this.gateway.dispatchMessage(id, message, recipientIds);
    return message;
  }

  @Post('conversations/:id/attachments/presign')
  presign(
    @Param('id') id: string,
    @Body() dto: PresignAttachmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.messaging.presignAttachment(id, user, dto);
  }

  @Get('attachments/:attachmentId')
  attachment(@Param('attachmentId') attachmentId: string, @CurrentUser() user: AuthUser) {
    return this.messaging.attachmentUrl(attachmentId, user);
  }

  @Post('conversations/:id/read')
  async read(
    @Param('id') id: string,
    @Body() dto: ReadDto,
    @CurrentUser() user: AuthUser,
  ) {
    const receipt = await this.messaging.markRead(id, user.id, dto.seq);
    this.gateway.broadcastReceipt(id, receipt);
    return receipt;
  }

  @Patch('conversations/:id')
  async rename(
    @Param('id') id: string,
    @Body() dto: RenameConversationDto,
    @CurrentUser() user: AuthUser,
  ) {
    const conversation = await this.messaging.rename(id, user, dto.title);
    await this.gateway.dispatchConversation(conversation, conversation.participants.map((p) => p.userId));
    return this.withPresence(conversation);
  }

  @Post('conversations/:id/participants')
  async addParticipants(
    @Param('id') id: string,
    @Body() dto: AddParticipantsDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { conversation, addedIds } = await this.messaging.addParticipants(id, user, dto);
    await this.gateway.dispatchConversation(conversation, conversation.participants.map((p) => p.userId));
    return { conversation: this.withPresence(conversation), addedIds };
  }

  @Delete('conversations/:id/participants/:userId')
  async removeParticipant(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.messaging.removeParticipant(id, user, userId);
    // Notify whoever remains so their member list refreshes.
    const remaining = await this.messaging.participantIds(id);
    if (remaining.length) await this.gateway.dispatchConversation({ id }, remaining);
    return result;
  }
}
