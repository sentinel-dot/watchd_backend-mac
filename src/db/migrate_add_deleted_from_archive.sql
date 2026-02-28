-- Migration: Add deleted_from_archive_at to room_members
-- Run with: mysql -u root -p watchd < migrate_add_deleted_from_archive.sql

ALTER TABLE `room_members`
  ADD COLUMN `deleted_from_archive_at` TIMESTAMP NULL DEFAULT NULL;
