import { Sequelize, SyncOptions } from 'sequelize';
import { SqlModelsType } from '../db.types';
import { SQL_MODELS } from '../models';
import { Logger } from '@nestjs/common';

export class SqlService {
  logger = new Logger(SqlService.name);
  public readonly models: SqlModelsType = {} as SqlModelsType;
  private readonly sequelize: Sequelize;

  constructor(uri: string) {
    /* eslint-disable @typescript-eslint/no-unsafe-call */
    try {
      const isRemote =
        uri &&
        !uri.includes('localhost') &&
        !uri.includes('127.0.0.1');

      this.sequelize = new Sequelize(uri || 'postgres://localhost:5432/postgres', {
        dialect: 'postgres',
        logging: process.env.NODE_ENV === 'production' ? false : console.log,
        dialectOptions: isRemote
          ? {
              ssl: {
                require: true,
                rejectUnauthorized: false,
              },
            }
          : {},
      });

      this.logger.log('Initializing models...');
      for (const [modelName, initFn] of Object.entries(SQL_MODELS)) {
        const typedModelName = modelName as keyof typeof SQL_MODELS;
        this.models[typedModelName] = initFn(this.sequelize) as any;
      }

      for (const model of Object.values(this.models)) {
        (model as any)?.associate?.(this.models);
      }

      this.logger.log('✅ All models initialized and associated.');
    } catch (err) {
      this.logger.error('Database connection error:', err);
      if (!process.env.VERCEL) {
        throw err;
      }
    }
  }

  public async init() {
    try {
      this.logger.log('Authenticating database connection...');
      await this.sequelize.authenticate();
      this.logger.log('✅ Successfully connected to PostgreSQL!');
    } catch (err) {
      this.logger.error(
        '❌ Failed to connect to the database.',
        err,
      );
      if (!process.env.VERCEL) {
        process.exit(1); // Immediately stop the app locally
        throw err;
      }
    }
  }

  async sync(options?: SyncOptions) {
    await this.sequelize.sync(options);
  }

  getSequelizeInstance(): Sequelize {
    return this.sequelize;
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.sequelize.authenticate();
      return true;
    } catch (error) {
      this.logger.error('Database connection error:', error);
      return false;
    }
  }
}
