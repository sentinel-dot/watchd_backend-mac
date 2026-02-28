-- Watchd Database Schema
-- Complete schema with all tables
-- Run with: mysql -u root -p watchd < schema.sql

SET FOREIGN_KEY_CHECKS = 0;

-- Drop existing tables
DROP TABLE IF EXISTS `password_reset_tokens`;
DROP TABLE IF EXISTS `favorites`;
DROP TABLE IF EXISTS `room_stack`;
DROP TABLE IF EXISTS `matches`;
DROP TABLE IF EXISTS `swipes`;
DROP TABLE IF EXISTS `room_members`;
DROP TABLE IF EXISTS `rooms`;
DROP TABLE IF EXISTS `users`;

SET FOREIGN_KEY_CHECKS = 1;

-- Users table
CREATE TABLE `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(64) NOT NULL,
  `email` VARCHAR(254) NULL,
  `password_hash` VARCHAR(255) NULL,
  `is_guest` BOOLEAN DEFAULT FALSE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_email` (`email`),
  INDEX `idx_email` (`email`),
  INDEX `idx_is_guest` (`is_guest`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Password reset tokens table
CREATE TABLE `password_reset_tokens` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `used` BOOLEAN DEFAULT FALSE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_token_hash` (`token_hash`),
  INDEX `idx_user_id` (`user_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rooms table
CREATE TABLE `rooms` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `code` VARCHAR(6) NOT NULL,
  `created_by` INT NOT NULL,
  `status` ENUM('waiting', 'active', 'dissolved') DEFAULT 'waiting',
  `name` VARCHAR(64) NULL,
  `filters` JSON NULL,
  `last_activity_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_code` (`code`),
  INDEX `idx_code` (`code`),
  INDEX `idx_created_by` (`created_by`),
  INDEX `idx_status` (`status`),
  INDEX `idx_last_activity` (`last_activity_at`),
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Room members table
CREATE TABLE `room_members` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `room_id` INT NOT NULL,
  `user_id` INT NOT NULL,
  `is_active` BOOLEAN DEFAULT TRUE,
  `joined_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `deleted_from_archive_at` TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY `unique_room_user` (`room_id`, `user_id`),
  INDEX `idx_room_id` (`room_id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_is_active` (`is_active`),
  FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Room stack table (for synchronized movie feeds)
CREATE TABLE `room_stack` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `room_id` INT NOT NULL,
  `movie_id` INT NOT NULL,
  `position` INT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_room_position` (`room_id`, `position`),
  INDEX `idx_movie_id` (`movie_id`),
  FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Swipes table
CREATE TABLE `swipes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `movie_id` INT NOT NULL,
  `room_id` INT NOT NULL,
  `direction` ENUM('left', 'right') NOT NULL,
  `swiped_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_user_movie_room` (`user_id`, `movie_id`, `room_id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_room_id` (`room_id`),
  INDEX `idx_movie_id` (`movie_id`),
  INDEX `idx_swiped_at` (`swiped_at`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Matches table
CREATE TABLE `matches` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `room_id` INT NOT NULL,
  `movie_id` INT NOT NULL,
  `watched` BOOLEAN DEFAULT FALSE,
  `matched_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_room_movie` (`room_id`, `movie_id`),
  INDEX `idx_room_id` (`room_id`),
  INDEX `idx_movie_id` (`movie_id`),
  INDEX `idx_matched_at` (`matched_at`),
  INDEX `idx_watched` (`watched`),
  FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Favorites table
CREATE TABLE `favorites` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `movie_id` INT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_user_movie` (`user_id`, `movie_id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_movie_id` (`movie_id`),
  INDEX `idx_created_at` (`created_at`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Done
SELECT 'Database schema created successfully!' AS status;
