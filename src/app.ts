import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error.js";
import authRouter from "./modules/auth/auth.routes.js";
import coursesRouter from "./modules/courses/courses.routes.js";
import meRouter from "./modules/me/me.routes.js";

export const app = express();

app.disable("x-powered-by");
if (env.TRUST_PROXY > 0) app.set("trust proxy", env.TRUST_PROXY);
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/v1/health", (_req, res) => {
  res.json({ ok: true, llmEnabled: env.llmEnabled });
});

app.use("/api/v1/auth", authRouter);
app.use("/api/v1", meRouter);
app.use("/api/v1/courses", coursesRouter);

app.use(notFound);
app.use(errorHandler);
