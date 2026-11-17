import type { Request, RequestHandler } from "express";
import { forgotBody, googleBody, loginBody, registerBody, resetBody, tokenBody } from "./auth.schema.js";
import * as svc from "./auth.service.js";

const device = (req: Request) => req.header("user-agent")?.slice(0, 200) ?? null;

export const register: RequestHandler = async (req, res) => {
  const { acceptTerms: _ok, ...input } = registerBody.parse(req.body);
  res.status(201).json(await svc.register(input, device(req)));
};

export const login: RequestHandler = async (req, res) => {
  res.json(await svc.login(loginBody.parse(req.body), device(req)));
};

export const google: RequestHandler = async (req, res) => {
  const b = googleBody.parse(req.body);
  res.json(await svc.googleLogin(b.credential, b.acceptTerms, device(req)));
};

export const refresh: RequestHandler = async (req, res) => {
  res.json(await svc.refresh(tokenBody.parse(req.body).refreshToken));
};

// Luôn trả 204 dù email có tồn tại hay không, để không lộ email nào đã đăng ký.
export const forgot: RequestHandler = async (req, res) => {
  await svc.requestPasswordReset(forgotBody.parse(req.body).email);
  res.status(204).end();
};

export const reset: RequestHandler = async (req, res) => {
  const b = resetBody.parse(req.body);
  await svc.resetPassword(b.token, b.password);
  res.status(204).end();
};

export const logout: RequestHandler = async (req, res) => {
  await svc.logout(tokenBody.parse(req.body).refreshToken);
  res.status(204).end();
};
