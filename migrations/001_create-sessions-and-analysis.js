exports.up = (pgm) => {
  // Sessions table
  pgm.createTable('sessions', {
    id: { type: 'text', primaryKey: true },
    scenario_id: { type: 'text', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Transcript messages table (one row per message, ordered by position)
  pgm.createTable('transcript_messages', {
    id: { type: 'serial', primaryKey: true },
    session_id: {
      type: 'text',
      notNull: true,
      references: 'sessions(id)',
      onDelete: 'CASCADE',
    },
    role: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  pgm.addConstraint('transcript_messages', 'transcript_messages_role_check', {
    check: "role IN ('user', 'assistant')",
  });

  pgm.addConstraint('transcript_messages', 'transcript_messages_session_position_unique', {
    unique: ['session_id', 'position'],
  });

  pgm.createIndex('transcript_messages', ['session_id', 'position']);

  // Analysis results table (one per session, stored as JSONB)
  pgm.createTable('analyses', {
    session_id: {
      type: 'text',
      primaryKey: true,
      references: 'sessions(id)',
      onDelete: 'CASCADE',
    },
    result: { type: 'jsonb', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('analyses');
  pgm.dropTable('transcript_messages');
  pgm.dropTable('sessions');
};
