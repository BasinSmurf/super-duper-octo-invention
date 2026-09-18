-- Admin-editable RBAC overrides (PermissionConfig singleton).
-- `matrix` JSONB stores ONLY overrides keyed by capability → array of roles;
-- absent capabilities fall back to code-defined DEFAULT_PERMISSIONS. The seed
-- row starts empty ('{}') so behavior matches the hardcoded defaults on day one.
CREATE TABLE "permission_config" (
    "id" TEXT NOT NULL,
    "matrix" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "permission_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "permission_config" ("id", "matrix", "updated_at")
VALUES (
    '51700000-0000-4000-8000-000000000030',
    '{}',
    CURRENT_TIMESTAMP
);
