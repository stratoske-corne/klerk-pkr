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
import { analyzeApiEndpoints, analyzeDatabaseSchema, analyzeExternalServices } from "./interfaces.js";
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

// ---------------------------------------------------------------------------
// Router mount-prefix resolution — found on a real 125-file repo (M6, real
// difficult-test run): every route file's path was extracted in isolation,
// with zero awareness of the `app.use('/api/x', xRoute)` call elsewhere that
// actually prefixes it. Two different real routers both using `.get('/:id')`
// (an extremely common pattern) collided under the old (method, path)-only
// de-dupe key and one silently vanished from the PKR — real data loss, not
// a cosmetic labeling issue.
// ---------------------------------------------------------------------------
describe("analyzeApiEndpoints — router mount-prefix resolution", () => {
  let root: string;

  beforeEach(() => {
    root = tmpRepo();
  });

  it("REGRESSION: two different routers using the identical relative path no longer collide once their real mount prefixes are known", () => {
    writeFile(root, "src/routes/glossary.js", "router.get('/:id', getGlossary);\n");
    writeFile(root, "src/routes/language.js", "router.get('/:id', getLanguage);\n");
    writeFile(
      root,
      "src/index.js",
      [
        "const glossaryRoutes = require('./routes/glossary');",
        "const languageRoutes = require('./routes/language');",
        "app.use('/api/glossary', glossaryRoutes);",
        "app.use('/api/language', languageRoutes);",
      ].join("\n"),
    );

    const nodes = analyzeApiEndpoints(
      root,
      inventoryOf(root, ["src/routes/glossary.js", "src/routes/language.js", "src/index.js"]),
      IdAllocator.load(tmpRepo()),
      "proj",
    );

    // Before the fix: both collapsed into a single "GET /:id" node, one silently dropped.
    expect(nodes.map((n) => n.title).sort()).toEqual(["GET /api/glossary/:id", "GET /api/language/:id"]);
  });

  it("resolves an ES-module default import the same way as a CommonJS require", () => {
    writeFile(root, "src/routes/user.js", "router.post('/register', register);\n");
    writeFile(
      root,
      "src/index.js",
      ["import userRoutes from './routes/user.js';", "app.use('/api/user', userRoutes);"].join("\n"),
    );

    const nodes = analyzeApiEndpoints(
      root,
      inventoryOf(root, ["src/routes/user.js", "src/index.js"]),
      IdAllocator.load(tmpRepo()),
      "proj",
    );
    expect(nodes.map((n) => n.title)).toEqual(["POST /api/user/register"]);
  });

  it("falls back to the old prefix-less behavior for a route file with no resolvable mount (never removes information, only adds it)", () => {
    writeFile(root, "src/routes/orphan.js", "router.get('/:id', getOne);\n");
    // No app.use() anywhere referencing this file at all.
    const nodes = analyzeApiEndpoints(root, inventoryOf(root, ["src/routes/orphan.js"]), IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.map((n) => n.title)).toEqual(["GET /:id"]);
  });

  it("does not mistake an inline middleware call for a router mount (e.g. app.use(cors(...)))", () => {
    writeFile(root, "src/routes/user.js", "router.get('/:id', getOne);\n");
    writeFile(
      root,
      "src/index.js",
      [
        "const userRoutes = require('./routes/user');",
        "app.use(cors({ origin: '*' }));", // single string-shaped-looking arg but not a literal prefix — must not confuse the parser
        "app.use('/api/user', userRoutes);",
      ].join("\n"),
    );
    const nodes = analyzeApiEndpoints(
      root,
      inventoryOf(root, ["src/routes/user.js", "src/index.js"]),
      IdAllocator.load(tmpRepo()),
      "proj",
    );
    expect(nodes.map((n) => n.title)).toEqual(["GET /api/user/:id"]);
  });

  it("emits one endpoint per prefix when the same router is mounted more than once", () => {
    writeFile(root, "src/routes/health.js", "router.get('/', ping);\n");
    writeFile(
      root,
      "src/index.js",
      [
        "const healthRoutes = require('./routes/health');",
        "app.use('/api/health', healthRoutes);",
        "app.use('/internal/health', healthRoutes);",
      ].join("\n"),
    );
    const nodes = analyzeApiEndpoints(
      root,
      inventoryOf(root, ["src/routes/health.js", "src/index.js"]),
      IdAllocator.load(tmpRepo()),
      "proj",
    );
    expect(nodes.map((n) => n.title).sort()).toEqual(["GET /api/health", "GET /internal/health"]);
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

describe("analyzeExternalServices", () => {
  it("detects known services from raw dependency package names (baseline)", () => {
    const nodes = analyzeExternalServices(["stripe", "mongoose"], IdAllocator.load(tmpRepo()), "proj");
    expect(nodes.map((n) => n.title).sort()).toEqual(["MongoDB (via Mongoose)", "Stripe"]);
  });

  it("REGRESSION: recognizes kafkajs, socket.io, and @google/generative-ai — found missing on a real repo (ARCHITECTURE.md §20)", () => {
    const nodes = analyzeExternalServices(
      ["kafkajs", "socket.io", "@google/generative-ai"],
      IdAllocator.load(tmpRepo()),
      "proj",
    );
    expect(nodes.map((n) => n.title).sort()).toEqual(["Google Generative AI (Gemini)", "Kafka (via KafkaJS)", "Socket.IO"]);
  });

  it("ignores unknown package names without erroring", () => {
    const nodes = analyzeExternalServices(["some-random-internal-utility"], IdAllocator.load(tmpRepo()), "proj");
    expect(nodes).toHaveLength(0);
  });
});
