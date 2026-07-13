"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTestApp = createTestApp;
exports.http = http;
exports.loginCookie = loginCookie;
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const library_1 = require("@prisma/client/runtime/library");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("../src/app.module");
const cookie_1 = require("../src/common/cookie");
library_1.Decimal.prototype.toJSON = function () {
    return this.toString();
};
async function createTestApp() {
    const moduleRef = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.use((0, cookie_parser_1.default)());
    app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    return app;
}
function http(app) {
    return (0, supertest_1.default)(app.getHttpServer());
}
async function loginCookie(app, email, password = 'Vfw@2026!') {
    const res = await http(app).post('/api/auth/login').send({ email, password });
    if (res.status !== 201 && res.status !== 200) {
        throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const setCookie = res.headers['set-cookie'];
    const cookie = (setCookie ?? []).find((c) => c.startsWith(`${cookie_1.SESSION_COOKIE}=`));
    if (!cookie)
        throw new Error(`no session cookie returned for ${email}`);
    return cookie.split(';')[0];
}
//# sourceMappingURL=app.js.map