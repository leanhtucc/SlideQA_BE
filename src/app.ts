import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error.js";

export const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/v1/health", (_req, res) => {
  res.json({ ok: true, llmEnabled: env.llmEnabled });
});

app.use(notFound);
app.use(errorHandler);
