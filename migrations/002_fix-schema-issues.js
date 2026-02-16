exports.up = (pgm) => {
  // Remove redundant index (the unique constraint already creates one)
  pgm.dropIndex('transcript_messages', ['session_id', 'position'], {
    ifExists: true,
  });

  // Add updated_at column to analyses
  pgm.addColumns('analyses', {
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Add position non-negative constraint
  pgm.addConstraint('transcript_messages', 'transcript_messages_position_check', {
    check: 'position >= 0',
  });

  // Add index on sessions.created_at for admin queries
  pgm.createIndex('sessions', ['created_at']);
};

exports.down = (pgm) => {
  pgm.dropIndex('sessions', ['created_at']);
  pgm.dropConstraint('transcript_messages', 'transcript_messages_position_check');
  pgm.dropColumns('analyses', ['updated_at']);
  pgm.createIndex('transcript_messages', ['session_id', 'position']);
};
