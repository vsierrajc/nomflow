import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { RecentAuthGuard } from '../auth/guards';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  ApproverSignatureError,
  MAX_APPROVER_SIGNATURE_BYTES,
  enrollApproverSignature,
  myApproverSignature,
  ownApproverSignatureImage,
  removeApproverSignature,
} from './approver-signature.service';

function map(e: unknown): never {
  if (e instanceof ApproverSignatureError) {
    if (e.code === 'NOT_FOUND') throw new NotFoundException({ code: e.code });
    if (e.code === 'NOT_APPROVER') throw new ForbiddenException({ code: e.code });
    throw new BadRequestException({ code: e.code });
  }
  throw e;
}

/** Quien aprueba vacaciones carga su firma en imagen y autoriza su uso en la constancia. */
@Controller('me/approver-signature')
@UseGuards(SessionGuard)
export class MeApproverSignatureController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@Req() req: AuthedRequest) {
    return myApproverSignature(this.db, req.auth.accountId);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_APPROVER_SIGNATURE_BYTES + 1, files: 1 } }),
  )
  async enroll(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { consent?: string },
    @Req() req: AuthedRequest,
  ) {
    if (!file) throw new BadRequestException({ code: 'INVALID_IMAGE' });
    try {
      await enrollApproverSignature(
        this.db,
        req.auth.accountId,
        file.buffer,
        body?.consent === 'true',
      );
      return { ok: true };
    } catch (e) {
      return map(e);
    }
  }

  @Delete()
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async remove(@Req() req: AuthedRequest) {
    try {
      await removeApproverSignature(this.db, req.auth.accountId);
    } catch (e) {
      return map(e);
    }
  }

  @Get('image')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async image(@Req() req: AuthedRequest, @Res() res: Response) {
    try {
      const img = await ownApproverSignatureImage(this.db, req.auth.accountId);
      res.setHeader('Content-Type', img.contentType).send(img.data);
    } catch (e) {
      return map(e);
    }
  }
}
