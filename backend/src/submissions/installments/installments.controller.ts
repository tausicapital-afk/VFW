import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { AuthUser, Can, CurrentUser } from '../../common/auth.guard';
import { MarkInstallmentDto, SetPlanDto } from './dto';
import { InstallmentsService } from './installments.service';

/**
 * The payment plan hangs off the sale it schedules, so it lives under the
 * submission's own path rather than at a top-level /api/installments. There is
 * no such thing as an instalment without a sale, and routing it this way means
 * every write already knows which record to scope against.
 *
 * Reading carries no permission of its own: the guard's row scope is the whole
 * control, and it comes from SubmissionsService.findOne. Whoever may open the
 * sale may see how it is being paid.
 */
@Controller('api/submissions/:id/installments')
export class InstallmentsController {
  constructor(private readonly installments: InstallmentsService) {}

  @Get()
  list(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.installments.list(id, user);
  }

  @Put()
  @Can('installment.plan')
  setPlan(@Param('id') id: string, @Body() dto: SetPlanDto, @CurrentUser() user: AuthUser) {
    return this.installments.setPlan(id, dto, user);
  }

  @Delete()
  @Can('installment.plan')
  clearPlan(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.installments.clearPlan(id, user);
  }

  @Post(':installmentId/mark')
  @Can('installment.mark')
  mark(
    @Param('id') id: string,
    @Param('installmentId') installmentId: string,
    @Body() dto: MarkInstallmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.installments.mark(id, installmentId, dto, user);
  }

  @Post(':installmentId/unmark')
  @Can('installment.mark')
  unmark(
    @Param('id') id: string,
    @Param('installmentId') installmentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.installments.unmark(id, installmentId, user);
  }
}
