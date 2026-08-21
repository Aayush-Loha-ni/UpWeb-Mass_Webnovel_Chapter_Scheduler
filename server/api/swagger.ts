/**
 * OpenAPI/Swagger documentation setup
 */

import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import type { Express } from 'express';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'UpWeb API',
      version: '1.0.0',
      description: 'API for managing novels, chapters, publishing automation, and browser sessions.',
    },
    servers: [
      { url: '/api/v1', description: 'API v1' },
    ],
    components: {
      schemas: {
        Novel: {
          type: 'object',
          properties: {
            slug: { type: 'string', example: 'my-novel' },
            name: { type: 'string', example: 'My Novel' },
          },
        },
        Tracker: {
          type: 'object',
          properties: {
            webnovel_last: { type: 'number', description: 'Last published chapter on Webnovel' },
            patreon_last: { type: 'number', description: 'Last published chapter on Patreon' },
            inkstone_scheduled_count: { type: 'number' },
            patreon_scheduled_count: { type: 'number' },
            next_schedule_date: { type: 'string', nullable: true },
            execution_status: { type: 'string', enum: ['idle', 'running', 'failed'] },
          },
        },
        Chapter: {
          type: 'object',
          properties: {
            chapter_number: { type: 'number' },
            title: { type: 'string' },
            file_path: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/novels': {
        get: {
          tags: ['Novels'],
          summary: 'List all novels',
          responses: { 200: { description: 'Array of novels with config and tracker' } },
        },
        post: {
          tags: ['Novels'],
          summary: 'Create a new novel',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['slug', 'name'], properties: { slug: { type: 'string' }, name: { type: 'string' } } } } },
          },
          responses: { 201: { description: 'Novel created' }, 409: { description: 'Already exists' } },
        },
      },
      '/novels/{slug}': {
        get: {
          tags: ['Novels'],
          summary: 'Get novel details',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Novel details with chapters' }, 404: { description: 'Not found' } },
        },
        delete: {
          tags: ['Novels'],
          summary: 'Delete a novel',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } },
        },
      },
      '/novels/{slug}/config': {
        put: {
          tags: ['Config'],
          summary: 'Update novel configuration',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Updated config' } },
        },
      },
      '/novels/{slug}/chapters': {
        post: {
          tags: ['Chapters'],
          summary: 'Create a new chapter',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['chapter_number', 'title', 'body'], properties: { chapter_number: { type: 'number' }, title: { type: 'string' }, body: { type: 'string' } } } } },
          },
          responses: { 201: { description: 'Chapter created' } },
        },
      },
      '/novels/{slug}/scrape': {
        post: {
          tags: ['Automation'],
          summary: 'Start scraping automation',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Scraping started' }, 409: { description: 'Already running' } },
        },
      },
      '/novels/{slug}/publish': {
        post: {
          tags: ['Automation'],
          summary: 'Start publishing automation',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: { mode: { type: 'string', enum: ['single', 'all'] }, dry_run: { type: 'boolean' } } } } },
          },
          responses: { 200: { description: 'Publishing started' }, 409: { description: 'Already running' } },
        },
      },
      '/novels/{slug}/abort': {
        post: {
          tags: ['Automation'],
          summary: 'Abort running automation',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Abort result' } },
        },
      },
      '/novels/{slug}/logs': {
        get: {
          tags: ['Logs'],
          summary: 'Get current execution logs',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Logs array' } },
        },
      },
      '/cdp/connect': {
        post: {
          tags: ['CDP'],
          summary: 'Connect to Chrome via CDP',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { port: { type: 'number' } } } } } },
          responses: { 200: { description: 'Connection result' } },
        },
      },
      '/cdp/status': {
        get: {
          tags: ['CDP'],
          summary: 'Get CDP connection status',
          responses: { 200: { description: 'CDP status' } },
        },
      },
      '/browser/status': {
        get: {
          tags: ['Browser'],
          summary: 'Get browser connection status',
          responses: { 200: { description: 'Browser status with cookie age' } },
        },
      },
    },
  },
  apis: [],
};

export function setupSwagger(app: Express): void {
  const swaggerSpec = swaggerJsdoc(options);
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'UpWeb API',
    customCss: '.swagger-ui .topbar { display: none }',
  }));
  app.get('/api/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}
