-- One postgres process, one database per bounded context.
-- `reviewer` is created by POSTGRES_DB; pergamon is created here so ops never change when it lands.
CREATE DATABASE pergamon OWNER smith;
