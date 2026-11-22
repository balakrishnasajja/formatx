import type { FormatId } from '../types/formats';

/** Realistic sample documents, one per format, loadable from the UI. */
export const SAMPLES: Record<FormatId, string> = {
  json: `{"name":"Krish","age":25,"verified":true,"email":null,"balance":12345678901234567890,
"address":{"city":"Bengaluru","zip":"560001","geo":[12.9716,77.5946]},
"tags":["developer","café ☕","日本語"],"projects":[{"id":1,"title":"FormatX","stars":4.5},{"id":2,"title":"Atlas","stars":3}]}`,

  jsonc: `// VS Code style settings with comments
{
  "editor.fontSize": 14, // inline comment
  /* block comment */
  "editor.tabSize": 2,
  "files.exclude": {
    "**/.git": true,
    "**/node_modules": true,
  },
}`,

  json5: `// JSON5 — JSON for humans
{
  unquoted: 'and you can quote me on that',
  singleQuotes: 'I can use "double quotes" here',
  lineBreaks: "Look, Mom! \\
No \\\\n's!",
  hexadecimal: 0xdecaf,
  leadingDecimalPoint: .8675309, andTrailing: 8675309.,
  positiveSign: +1,
  trailingComma: 'in objects', andIn: ['arrays',],
  "backwardsCompatible": "with JSON",
}`,

  xml: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Product catalog -->
<catalog xmlns:media="http://example.com/media">
<book id="bk101" available="true"><author>Gambardella, Matthew</author><title>XML Developer's Guide</title>
<genre>Computer</genre><price currency="USD">44.95</price>
<description><![CDATA[An in-depth look at <XML> & friends.]]></description></book>
<book id="bk102" available="false"><author>Ralls, Kim</author><title>Midnight Rain</title><genre>Fantasy</genre><price currency="EUR">5.95</price><media:cover src="rain.png"/></book>
</catalog>`,

  yaml: `# Kubernetes-style deployment
apiVersion: apps/v1
kind: Deployment
metadata:
    name: web-frontend
    labels: {app: web, tier: frontend}
spec:
    replicas: 3
    template:
        spec:
            containers:
                - name: web
                  image: "nginx:1.27"
                  ports:
                      - containerPort: 80
                  env:
                      - name: GREETING
                        value: |
                            Hello,
                            world!
`,

  toml: `# Application configuration
title="FormatX"
version   =   "1.0.0"

[owner]
name="Krish"
dob=1979-05-27T07:32:00-08:00

[database]
enabled=true
ports=[ 8000,8001,  8002 ]
data = [ ["delta", "phi"], [3.14] ]
temp_targets = { cpu = 79.5, case = 72.0 }

[[servers]]
name="alpha"   # primary
ip="10.0.0.1"

[[servers]]
name="beta"
ip="10.0.0.2"
`,

  csv: `id,name,email,city,score,active
1,Ada Lovelace,ada@example.com,London,98.5,true
2,"Hopper, Grace",grace@example.com,New York,95,true
3,Alan Turing,alan@example.com,"Wilmslow, Cheshire",99.1,false
4,Linus Torvalds,linus@example.com,Helsinki,87,true
5,"Quote ""Q"" Tester",q@example.com,Zürich,0042,false`,

  tsv: `id\tproduct\tcategory\tprice\tin_stock
101\tMechanical Keyboard\tPeripherals\t129.99\ttrue
102\tUSB-C Hub\tAccessories\t39.50\tfalse
103\t4K Monitor\tDisplays\t399.00\ttrue`,

  ini: `; Application settings
[general]
app_name=FormatX
debug  =  false

[database]
host = localhost
port = 5432
; credentials are loaded from the environment
user = admin

[paths]
data_dir = /var/lib/formatx
log_dir=/var/log/formatx`,

  env: `# Application environment
NODE_ENV=production
PORT=3000
DATABASE_URL="postgres://user:pass@localhost:5432/app"
export API_KEY=sk_test_1234567890
GREETING="Hello\\nWorld"
EMPTY=
# Interpolation is kept as written
LOG_DIR=\${HOME}/logs`,

  properties: `# Spring Boot application.properties
server.port=8080
server.servlet.context-path = /api
spring.datasource.url=jdbc:postgresql://localhost:5432/app
spring.datasource.username : admin
app.message=Hello, \\
    World!
app.unicode=Caf\\u00e9
! legacy comment style
app.features[0]=search
app.features[1]=export`,

  html: `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>FormatX demo</title>
<style>body{font-family:system-ui;margin:2rem}.card{padding:1rem;border:1px solid #ccc}</style></head>
<body><header><h1>Hello, FormatX</h1><nav><a href="#docs">Docs</a> | <a href="#about">About</a></nav></header>
<main><div class="card"><p>Format, validate and convert <strong>any</strong> data.</p><ul><li>JSON</li><li>XML</li><li>YAML</li></ul></div>
<img src="logo.png" alt="FormatX logo"></main></body></html>`,

  css: `:root{--accent:#22d3ee;--radius:8px}
body{margin:0;font-family:Inter,system-ui,sans-serif;background:#0b0f17;color:#e6ebf2}
.button,.button:visited{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;border-radius:var(--radius);background:linear-gradient(135deg,var(--accent),#8b5cf6)}
.button:hover{filter:brightness(1.1)}
@media (max-width: 640px){.button{width:100%}}`,

  scss: `// Variables & mixins
$primary: #22d3ee;
$radius: 8px;
@mixin card($pad: 1rem) { padding: $pad; border-radius: $radius; }
.panel{ @include card(1.5rem); background: rgba($primary, .1);
  &__title{ font-weight: 600; color: darken($primary, 10%); }
  &:hover{ box-shadow: 0 0 0 1px $primary; }
  .item + .item { margin-top: .5rem }
}`,

  javascript: `import { readFile } from 'node:fs/promises';
const greet=(name='world')=>{ return \`Hello, \${name}!\` }
export async function loadConfig(path){const raw=await readFile(path,'utf8');const config=JSON.parse(raw);
if(!config.version){throw new Error("Missing version")}
return {...config,loadedAt:new Date().toISOString()}}
class Counter{#count=0;increment(){this.#count++;return this.#count}}
console.log(greet('FormatX'),new Counter().increment())`,

  typescript: `interface User { id: number; name: string; email?: string; roles: Array<'admin'|'editor'|'viewer'> }
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export function findUser(users: User[], id: number): Result<User> {
const user=users.find(u=>u.id===id);
return user?{ok:true,value:user}:{ok:false,error:\`User \${id} not found\`}}
enum Level { Low = 1, High }
export class Cache<K, V> { private store = new Map<K, V>(); get(key: K): V | undefined { return this.store.get(key) } }`,

  markdown: `# FormatX
A **universal** data formatter & validator.
## Features
* Detect formats automatically
* Validate with *real* parsers
- Convert JSON ⇄ YAML ⇄ TOML
### Example
\`\`\`json
{"hello": "world"}
\`\`\`
| Format | Validate | Format |
|---|:---:|---:|
| JSON | yes | yes |
| SQL | yes | yes |

> Your data never leaves the browser.

[Documentation](https://example.com/docs) · ![logo](logo.png)`,

  php: `<?php
namespace App\\Http;
use Psr\\Log\\LoggerInterface;
final class UserController{
public function __construct(private LoggerInterface $logger){}
public function show(int $id): array{ $user=['id'=>$id,'name'=>"User {$id}"];
$this->logger->info('Showing user',['id'=>$id]);
return $user;}
}`,

  python: `import json
from dataclasses import dataclass, field

@dataclass
class User:
    id: int
    name: str
    tags: list[str] = field(default_factory=list)

def load_users(path):
    with open(path) as fh:
        return [User(**row) for row in json.load(fh)]

if __name__ == "__main__":
    for user in load_users("users.json"):
        print(f"{user.id}: {user.name}")
`,

  java: `package com.example.demo;
import java.util.List;
import java.util.stream.Collectors;
public class UserService {
private final List<String> users = List.of("ada","grace","alan");
public List<String> upperCaseNames(){return users.stream().map(String::toUpperCase).collect(Collectors.toList());}
public static void main(String[] args){System.out.println(new UserService().upperCaseNames());}
}`,

  sql: `select u.id, u.name, count(o.id) as order_count, sum(o.total) as revenue
from users u left join orders o on o.user_id = u.id
where u.created_at >= '2024-01-01' and u.status in ('active','trial')
group by u.id, u.name having count(o.id) > 2 order by revenue desc limit 10;
insert into audit_log (user_id, action) values (42, 'export');`,

  graphql: `query GetUser($id: ID!, $withPosts: Boolean = false) { user(id: $id) { id name email
posts(first: 5) @include(if: $withPosts) { edges { node { id title } } } ...UserFields } }
fragment UserFields on User { createdAt avatarUrl(size: 64) }`,

  openapi: `openapi: 3.0.3
info:
  title: Pet Store
  version: 1.0.0
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: A single pet
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id: { type: integer, format: int64 }
        name: { type: string }
`,

  jsonschema: `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/user.schema.json",
  "title": "User",
  "type": "object",
  "required": ["id", "email"],
  "properties": {
    "id": { "type": "integer", "minimum": 1 },
    "email": { "type": "string", "format": "email" },
    "tags": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
    "address": { "$ref": "#/$defs/address" }
  },
  "$defs": {
    "address": { "type": "object", "properties": { "city": { "type": "string" } } }
  }
}`,

  // {"name": "FormatX", "version": 1, "tags": ["fast", "local"]} encoded as BSON
  bson: `48 00 00 00 02 6e 61 6d 65 00 08 00 00 00 46 6f
72 6d 61 74 58 00 10 76 65 72 73 69 6f 6e 00 01
00 00 00 04 74 61 67 73 00 1e 00 00 00 02 30 00
05 00 00 00 66 61 73 74 00 02 31 00 06 00 00 00
6c 6f 63 61 6c 00 00 00`,

  // {"name": "FormatX", "version": 1, "tags": ["fast", "local"]} encoded as MessagePack
  msgpack: `83 a4 6e 61 6d 65 a7 46 6f 72 6d 61 74 58 a7 76
65 72 73 69 6f 6e 01 a4 74 61 67 73 92 a4 66 61
73 74 a5 6c 6f 63 61 6c`,

  protobuf: `syntax = "proto3";
package demo.v1;
option go_package = "example.com/demo/v1;demov1";
import "google/protobuf/timestamp.proto";
// A user of the system
message User{
  int64 id=1;
  string name=2;
  repeated string tags=3;
  google.protobuf.Timestamp created_at=4;
  enum Role{ROLE_UNSPECIFIED=0;ADMIN=1;EDITOR=2;}
  Role role=5;
  map<string,string> labels=6;
}
service UserService{
  rpc GetUser(GetUserRequest) returns (User);
}
message GetUserRequest{int64 id=1;}`,
};
