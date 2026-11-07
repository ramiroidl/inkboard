import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import {
  InvalidTodoRequestError,
  MAX_SELECTED_LISTS,
  type TodoService,
} from "../todo/todo-service.js";

const ErrorSchema = Type.Object({ error: Type.String() });
const NullableString = Type.Union([Type.String(), Type.Null()]);

const MicrosoftTodoStatusSchema = Type.Object({
  state: Type.Union([
    Type.Literal("not_configured"),
    Type.Literal("signed_out"),
    Type.Literal("pending"),
    Type.Literal("signed_in"),
    Type.Literal("reauth_required"),
  ]),
  clientId: NullableString,
  tenant: Type.String(),
  account: NullableString,
  signIn: Type.Union([
    Type.Object({
      userCode: Type.String(),
      verificationUri: Type.String(),
      expiresAt: Type.String(),
    }),
    Type.Null(),
  ]),
  selectedListIds: Type.Array(Type.String()),
  lists: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      taskCount: Type.Integer(),
      lastSuccessfulRefreshAt: NullableString,
      lastError: NullableString,
    }),
  ),
  taskCount: Type.Integer(),
  lastSuccessfulRefreshAt: NullableString,
  lastError: NullableString,
});

/** Admin endpoints to connect Microsoft To Do. Tokens never leave the controller. */
export function microsoftTodoRoutes(todoService: TodoService): FastifyPluginAsyncTypebox {
  return async (app) => {
    // The admin page polls this while a sign-in code is shown, which completes the sign-in.
    app.get(
      "/api/v1/admin/microsoft-todo",
      { schema: { response: { 200: MicrosoftTodoStatusSchema } } },
      async () => {
        await todoService.pollSignIn();
        return todoService.getStatus();
      },
    );

    app.put(
      "/api/v1/admin/microsoft-todo/settings",
      {
        schema: {
          body: Type.Object(
            {
              clientId: Type.String({ maxLength: 64 }),
              tenant: Type.String({ maxLength: 128 }),
            },
            { additionalProperties: false },
          ),
          response: { 200: MicrosoftTodoStatusSchema, 400: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return await todoService.configure(request.body);
        } catch (error: unknown) {
          if (error instanceof InvalidTodoRequestError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.post(
      "/api/v1/admin/microsoft-todo/sign-in",
      { schema: { response: { 200: MicrosoftTodoStatusSchema, 400: ErrorSchema } } },
      async (_request, reply) => {
        try {
          return await todoService.startSignIn();
        } catch (error: unknown) {
          if (error instanceof InvalidTodoRequestError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );

    app.delete(
      "/api/v1/admin/microsoft-todo/sign-in",
      { schema: { response: { 200: MicrosoftTodoStatusSchema } } },
      async () => todoService.cancelSignIn(),
    );

    app.post(
      "/api/v1/admin/microsoft-todo/sign-out",
      { schema: { response: { 200: MicrosoftTodoStatusSchema } } },
      async () => todoService.signOut(),
    );

    app.get(
      "/api/v1/admin/microsoft-todo/lists",
      {
        schema: {
          response: {
            200: Type.Object({
              available: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
              selected: Type.Array(Type.String()),
              error: NullableString,
            }),
          },
        },
      },
      async () => todoService.listLists(),
    );

    app.put(
      "/api/v1/admin/microsoft-todo/lists",
      {
        schema: {
          body: Type.Object(
            {
              listIds: Type.Array(Type.String({ maxLength: 512 }), {
                maxItems: MAX_SELECTED_LISTS,
              }),
            },
            { additionalProperties: false },
          ),
          response: { 200: MicrosoftTodoStatusSchema, 400: ErrorSchema },
        },
      },
      async (request, reply) => {
        try {
          return await todoService.setSelection(request.body.listIds);
        } catch (error: unknown) {
          if (error instanceof InvalidTodoRequestError) {
            return reply.code(400).send({ error: error.message });
          }
          throw error;
        }
      },
    );
  };
}
