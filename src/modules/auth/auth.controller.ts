import type { Request, RequestHandler } from "express";
import { loginBody, registerBody, tokenBody } from "./auth.schema.js";
import * as svc from "./auth.service.js";

const device = (req: Request) => req.header("user-agent")?.slice(0, 200) ?? null;

export const register: RequestHandler = async (req, res) => {
  const { acceptTerms: _ok, ...input } = registerBody.parse(req.body);
  res.status(201).json(await svc.register(input, device(req)));
};

export const login: RequestHandler = async (req, res) => {
  res.json(await svc.login(loginBody.parse(req.body), device(req)));
};

export const refresh: RequestHandler = async (req, res) => {
  res.json(await svc.refresh(tokenBody.parse(req.body).refreshToken));
};

export const logout: RequestHandler = async (req, res) => {
  await svc.logout(tokenBody.parse(req.body).refreshToken);
  res.status(204).end();
};
