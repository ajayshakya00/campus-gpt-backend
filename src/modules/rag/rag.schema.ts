import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

export class KnowledgeCardModel extends Model<
  InferAttributes<KnowledgeCardModel>,
  InferCreationAttributes<KnowledgeCardModel>
> {
  declare id: CreationOptional<string>;
  declare entityType: string;
  declare entityId: string;
  declare title: string;
  declare content: string;
  declare metadata: CreationOptional<Record<string, any>>;
  declare embedding?: any;
  declare readonly createdAt?: Date;
  declare readonly updatedAt?: Date;

  static setup(sequelize: Sequelize) {
    KnowledgeCardModel.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        entityType: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        entityId: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        title: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        content: {
          type: DataTypes.TEXT,
          allowNull: false,
        },
        metadata: {
          type: DataTypes.JSONB,
          defaultValue: {},
        },
        embedding: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
      },
      {
        sequelize,
        tableName: 'campus_knowledge_cards',
        modelName: 'KnowledgeCardModel',
        timestamps: true,
      },
    );

    return KnowledgeCardModel;
  }
}
