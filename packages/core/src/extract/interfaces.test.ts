/**
 * Covers the two real gaps found during the M3 blind-reconstruction
 * experiment (ARCHITECTURE.md §16/§18): chained `router.route(x).get()...`
 * syntax and Mongoose schema detection. Also a couple of baseline/regression
 * cases so a future change can't silently break the patterns that already
 * worked.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { IdAllocator } from "../ids.js";
import { analyzeApiEndpoints, analyzeDatabaseSchema } from "./interfaces.js";
import type { Inventory } from "./inventory.js";

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "klerk-iface-"));
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function inventoryOf(root: string, relPaths: string[]): Inventory {
  return {
    root,
    files: relPaths.map((p) => ({ path: p, kind: "source" as const, sizeBytes: 1, sha256: "irrelevant" })),
  };
}

describe("analyzeApiEndpoints", () => {
  let root: string;

  beforeEach(() => {
    root = tmpRepo();
  });

  it("detects direct call-per-verb routes (baseline)", () => {
    writeFile(root, "src/routes.ts", `router.get('/users', listUsers);\nrouter.post('/users', createUser);\n`);
    const nodes = analyzeApiEndpoints(root, inventoryOf(root, ["src/routes.ts"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.map((n) => n.title).sort()).toEqual(["GET /users", "POST /users"]);
  });

  it("detects a chained router.route(x).get().post().delete() — the M3 gap", () => {
    writeFile(
      root,
      "src/user.route.ts",
      `router.route('/users/:userId')\n  .get(getUser)\n  .post(createUser)\n  .delete(removeUser);\n`,
    );
    const nodes = analyzeApiEndpoints(root, inventoryOf(root, ["src/user.route.ts"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.map((n) => n.title).sort()).toEqual([
      "DELETE /users/:userId",
      "GET /users/:userId",
      "POST /users/:userId",
    ]);
  });

  it("doesn't let a chain's handler body leak into the next statement", () => {
    writeFile(
      root,
      "src/routes.ts",
      [
        "router.route('/a')",
        "  .get((req, res) => { res.json({ ok: true }); })",
        "  .post(create);",
        "",
        "router.get('/b', listB);",
      ].join("\n"),
    );
    const nodes = analyzeApiEndpoints(root, inventoryOf(root, ["src/routes.ts"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.map((n) => n.title).sort()).toEqual(["GET /a", "GET /b", "POST /a"]);
  });

  it("handles multiple independent chains in the same file", () => {
    writeFile(
      root,
      "src/routes.ts",
      [
        "router.route('/users').get(list).post(create);",
        "router.route('/users/:id').get(getOne).patch(update).delete(remove);",
      ].join("\n"),
    );
    const nodes = analyzeApiEndpoints(root, inventoryOf(root, ["src/routes.ts"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.map((n) => n.title).sort()).toEqual([
      "DELETE /users/:id",
      "GET /users",
      "GET /users/:id",
      "PATCH /users/:id",
      "POST /users",
    ]);
  });
});

describe("analyzeDatabaseSchema — Mongoose", () => {
  let root: string;

  beforeEach(() => {
    root = tmpRepo();
  });

  it("detects a mongoose.Schema + mongoose.model() pair and its top-level fields — the M3 gap", () => {
    writeFile(
      root,
      "src/user.model.js",
      [
        "const mongoose = require('mongoose');",
        "",
        "const userSchema = new mongoose.Schema({",
        "  name: { type: String, required: true },",
        "  email: { type: String, unique: true },",
        "  age: Number,",
        "  tags: [String],",
        "});",
        "",
        "module.exports = mongoose.model('User', userSchema);",
      ].join("\n"),
    );
    const nodes = analyzeDatabaseSchema(root, inventoryOf(root, ["src/user.model.js"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].title).toBe("User");
    expect(nodes[0].content).toContain("name: String");
    expect(nodes[0].content).toContain("email: String");
    expect(nodes[0].content).toContain("age: Number");
    expect(nodes[0].content).toContain("tags: array");
  });

  it("detects the destructured import style (`import { Schema, model } from 'mongoose'`)", () => {
    writeFile(
      root,
      "src/token.model.ts",
      [
        "import { Schema, model } from 'mongoose';",
        "",
        "const tokenSchema = new Schema({",
        "  token: String,",
        "  expires: Date,",
        "});",
        "",
        "export default model('Token', tokenSchema);",
      ].join("\n"),
    );
    const nodes = analyzeDatabaseSchema(root, inventoryOf(root, ["src/token.model.ts"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].title).toBe("Token");
    expect(nodes[0].content).toContain("token: String");
    expect(nodes[0].content).toContain("expires: Date");
  });

  it("does not fire on an unrelated bare model(...) call when the file never imports mongoose (false-positive guard)", () => {
    writeFile(
      root,
      "src/pricing.ts",
      "function model(name, config) { return { name, config }; }\nconst pricingModel = model('tiered', {});\n",
    );
    const nodes = analyzeDatabaseSchema(root, inventoryOf(root, ["src/pricing.ts"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes).toHaveLength(0);
  });

  it("still emits a model node (without field detail) when the schema variable isn't declared in the same file", () => {
    writeFile(
      root,
      "src/order.model.js",
      "const mongoose = require('mongoose');\nconst orderSchema = require('./order.schema');\nmodule.exports = mongoose.model('Order', orderSchema);\n",
    );
    const nodes = analyzeDatabaseSchema(root, inventoryOf(root, ["src/order.model.js"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].title).toBe("Order");
    expect(nodes[0].content).toContain("field detail wasn't resolved");
  });

  it("handles a realistic schema: options object as 2nd arg, nested validator function bodies, and a .pre() hook after the model call — modeled on the actual M3 repo's user.model.js", () => {
    writeFile(
      root,
      "src/user.model.js",
      [
        "const mongoose = require('mongoose');",
        "",
        "const userSchema = new mongoose.Schema(",
        "  {",
        "    name: { type: String, required: true, trim: true },",
        "    email: { type: String, required: true, unique: true },",
        "    password: {",
        "      type: String,",
        "      required: true,",
        "      minlength: 8,",
        "      validate(value) {",
        "        if (!value.match(/\\d/)) {",
        "          throw new Error('Password must contain a number');",
        "        }",
        "      },",
        "    },",
        "    role: { type: String, enum: ['user', 'admin'], default: 'user' },",
        "  },",
        "  {",
        "    timestamps: true,",
        "  }",
        ");",
        "",
        "userSchema.pre('save', async function (next) {",
        "  const user = this;",
        "  if (user.isModified('password')) {",
        "    user.password = await bcrypt.hash(user.password, 8);",
        "  }",
        "  next();",
        "});",
        "",
        "module.exports = mongoose.model('User', userSchema);",
      ].join("\n"),
    );
    const nodes = analyzeDatabaseSchema(root, inventoryOf(root, ["src/user.model.js"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes).toHaveLength(1); // the .pre() hook's own braces must not confuse this into extra/garbage nodes
    expect(nodes[0].title).toBe("User");
    expect(nodes[0].content).toContain("name: String");
    expect(nodes[0].content).toContain("email: String");
    expect(nodes[0].content).toContain("password: String"); // type extracted from the multi-line field object, not the validator body
    expect(nodes[0].content).toContain("role: String");
  });

  it("Prisma detection still works unchanged (regression baseline)", () => {
    writeFile(root, "schema.prisma", "model Post {\n  id    Int    @id\n  title String\n}\n");
    const nodes = analyzeDatabaseSchema(root, inventoryOf(root, ["schema.prisma"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.map((n) => n.title)).toEqual(["Post"]);
  });
});
