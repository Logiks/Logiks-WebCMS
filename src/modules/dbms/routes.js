import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http/errors.js';
import { actorOf, requirePermission } from '../../core/http/middleware.js';

/** System → Database (docs/DECISIONS.md D-047): browse/edit tables, create/drop tables, and a raw SQL console. */
export default function dbmsRoutes(ctx) {
  const r = Router();
  const { dbms } = ctx;

  r.get('/dbms/tables', requirePermission('dbms.read'), async (_req, res) => {
    res.json({ tables: await dbms.listTables(), typeLabels: dbms.typeLabels });
  });

  r.get('/dbms/tables/:table', requirePermission('dbms.read'), async (req, res) => {
    res.json(await dbms.tableInfo(req.params.table));
  });

  r.get('/dbms/tables/:table/rows', requirePermission('dbms.read'), async (req, res) => {
    const { page, per_page: perPage, sort, dir } = req.query;
    res.json(await dbms.listRows(req.params.table, { page, perPage, sort, sortDir: dir }));
  });

  r.post('/dbms/tables/:table/rows', requirePermission('dbms.write'), async (req, res) => {
    res.status(201).json(await dbms.createRecord(req.params.table, req.body ?? {}, actorOf(req)));
  });

  const rowBody = z.object({
    pk: z.record(z.string(), z.unknown()),
    data: z.record(z.string(), z.unknown()),
  });
  r.put('/dbms/tables/:table/rows', requirePermission('dbms.write'), async (req, res) => {
    const { pk, data } = parse(rowBody, req.body);
    await dbms.updateRecord(req.params.table, pk, data, actorOf(req));
    res.status(204).end();
  });

  const pkBody = z.object({ pk: z.record(z.string(), z.unknown()) });
  r.delete('/dbms/tables/:table/rows', requirePermission('dbms.write'), async (req, res) => {
    const { pk } = parse(pkBody, req.body);
    await dbms.deleteRecord(req.params.table, pk, actorOf(req));
    res.status(204).end();
  });

  const createTableBody = z.object({
    name: z.string().min(1).max(64),
    columns: z
      .array(
        z.object({
          name: z.string().min(1).max(64),
          type: z.string(),
          nullable: z.boolean().default(true),
          default: z.unknown().optional(),
          primaryKey: z.boolean().default(false),
          autoIncrement: z.boolean().default(false),
          length: z.number().optional(),
        }),
      )
      .min(1),
  });
  r.post('/dbms/tables', requirePermission('dbms.write'), async (req, res) => {
    const body = parse(createTableBody, req.body);
    await dbms.createTable(body, actorOf(req));
    res.status(201).json({ name: body.name });
  });

  r.delete('/dbms/tables/:table', requirePermission('dbms.write'), async (req, res) => {
    await dbms.dropTable(req.params.table, actorOf(req));
    res.status(204).end();
  });

  const queryBody = z.object({ sql: z.string().min(1).max(50_000) });
  r.post('/dbms/query', requirePermission('dbms.query'), async (req, res) => {
    const { sql } = parse(queryBody, req.body);
    res.json(await dbms.runQuery(sql, actorOf(req)));
  });

  r.get('/dbms/saved-queries', requirePermission('dbms.query'), async (_req, res) => {
    res.json({ queries: await dbms.listSavedQueries() });
  });

  const savedQueryBody = z.object({
    name: z.string().min(1).max(200),
    sql: z.string().min(1).max(50_000),
  });
  r.post('/dbms/saved-queries', requirePermission('dbms.query'), async (req, res) => {
    const body = parse(savedQueryBody, req.body);
    res.status(201).json(await dbms.saveQuery(body, actorOf(req)));
  });

  r.delete('/dbms/saved-queries/:id', requirePermission('dbms.query'), async (req, res) => {
    await dbms.deleteSavedQuery(req.params.id, actorOf(req));
    res.status(204).end();
  });

  return r;
}
