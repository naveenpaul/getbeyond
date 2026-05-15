import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('healthz')
  health(): { status: 'ok'; version: string } {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.0',
    };
  }
}
