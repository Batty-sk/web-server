import { Router } from 'express';

import { deleteUser, getUser, updateUserName } from '../auth/accounts.js';
import { endSession, requireUser } from '../auth/sessions.js';
import { HttpError } from '../http/errors.js';

/** The signed-in person's own account. Subscriptions and templates will hang off this. */
export const meRouter = Router();

meRouter.use(requireUser);

meRouter.get('/', async (_req, res) => {
  const user = await getUser(res.locals.userId as string);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  res.json({ user });
});

meRouter.patch('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.replace(/\s+/g, ' ').trim() : null;
  if (name === null || name.length > 80) throw new HttpError(400, 'Use a name of up to 80 characters.', 'name');
  await updateUserName(res.locals.userId as string, name);
  res.json({ user: await getUser(res.locals.userId as string) });
});

meRouter.delete('/', async (req, res) => {
  await deleteUser(res.locals.userId as string);
  await endSession(req, res, 'user');
  res.status(204).end();
});
