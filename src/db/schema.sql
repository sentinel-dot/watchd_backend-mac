-- Watchd Database Schema
-- Partnerships-Modell (statt Rooms): persistente 1:1-Verbindungen, kein Gast-Zugang.
-- Run with: mysql -u root -p watchd < schema.sql

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `password_reset_tokens`;
DROP TABLE IF EXISTS `refresh_tokens`;
DROP TABLE IF EXISTS `favorites`;
DROP TABLE IF EXISTS `partnership_stack`;
DROP TABLE IF EXISTS `matches`;
DROP TABLE IF EXISTS `swipes`;
DROP TABLE IF EXISTS `partnership_members`;
DROP TABLE IF EXISTS `partnerships`;
-- Legacy-Tabellen aus Pre-Partnerships-Schema (defensiv droppen, falls Dev-DB alt ist)
DROP TABLE IF EXISTS `room_stack`;
DROP TABLE IF EXISTS `room_members`;
DROP TABLE IF EXISTS `rooms`;
DROP TABLE IF EXISTS `users`;

SET FOREIGN_KEY_CHECKS = 1;

-- USERS ---------------------------------------------------------
CREATE TABLE `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(64) NOT NULL,
  `email` VARCHAR(254) NULL,
  `password_hash` VARCHAR(255) NULL,
  `apple_id` VARCHAR(255) NULL,
  `google_id` VARCHAR(255) NULL,
  `share_code` CHAR(8) NOT NULL,
  `device_token` VARCHAR(255) NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_email` (`email`),
  UNIQUE KEY `unique_apple_id` (`apple_id`),
  UNIQUE KEY `unique_google_id` (`google_id`),
  UNIQUE KEY `unique_share_code` (`share_code`),
  INDEX `idx_email` (`email`),
  INDEX `idx_share_code` (`share_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PARTNERSHIPS --------------------------------------------------
-- user_a_id / user_b_id sind generierte Spalten (LEAST/GREATEST der beiden
-- User-IDs) und tragen den UNIQUE-Index für das Paar — das funktioniert
-- portabel auf MySQL 5.7+/8 und MariaDB 10.2+ (im Gegensatz zu MySQL-8-only
-- functional indexes auf LEAST/GREATEST direkt).
CREATE TABLE `partnerships` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `status` ENUM('pending', 'active') NOT NULL DEFAULT 'pending',
  `requester_id` INT NOT NULL,
  `addressee_id` INT NOT NULL,
  `user_a_id` INT GENERATED ALWAYS AS (LEAST(`requester_id`, `addressee_id`)) STORED,
  `user_b_id` INT GENERATED ALWAYS AS (GREATEST(`requester_id`, `addressee_id`)) STORED,
  `filters` JSON NULL,
  `stack_next_page` INT NOT NULL DEFAULT 6,
  `stack_generating` TINYINT(1) NOT NULL DEFAULT 0,
  `stack_exhausted` TINYINT(1) NOT NULL DEFAULT 0,
  `last_activity_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `accepted_at` TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY `unique_pair` (`user_a_id`, `user_b_id`),
  INDEX `idx_requester` (`requester_id`),
  INDEX `idx_addressee` (`addressee_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_last_activity` (`last_activity_at`),
  FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`addressee_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PARTNERSHIP MEMBERS (denormalisiert für einfache Joins) -------
-- Pro Partnerschaft immer 2 Rows (requester + addressee).
-- Separat gehalten, weil Swipes/Matches so leichter joinable sind
-- (wir brauchen oft: "gib mir alle User einer Partnerschaft").
CREATE TABLE `partnership_members` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `partnership_id` INT NOT NULL,
  `user_id` INT NOT NULL,
  `joined_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_partnership_user` (`partnership_id`, `user_id`),
  INDEX `idx_partnership_id` (`partnership_id`),
  INDEX `idx_user_id` (`user_id`),
  FOREIGN KEY (`partnership_id`) REFERENCES `partnerships`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PARTNERSHIP STACK ---------------------------------------------
CREATE TABLE `partnership_stack` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `partnership_id` INT NOT NULL,
  `movie_id` INT NOT NULL,
  `position` INT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_partnership_movie` (`partnership_id`, `movie_id`),
  INDEX `idx_partnership_position` (`partnership_id`, `position`),
  INDEX `idx_movie_id` (`movie_id`),
  FOREIGN KEY (`partnership_id`) REFERENCES `partnerships`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SWIPES --------------------------------------------------------
CREATE TABLE `swipes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `movie_id` INT NOT NULL,
  `partnership_id` INT NOT NULL,
  `direction` ENUM('left', 'right') NOT NULL,
  `swiped_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_user_movie_partnership` (`user_id`, `movie_id`, `partnership_id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_partnership_id` (`partnership_id`),
  INDEX `idx_movie_id` (`movie_id`),
  INDEX `idx_swiped_at` (`swiped_at`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`partnership_id`) REFERENCES `partnerships`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- MATCHES -------------------------------------------------------
CREATE TABLE `matches` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `partnership_id` INT NOT NULL,
  `movie_id` INT NOT NULL,
  `watched` BOOLEAN DEFAULT FALSE,
  `matched_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_partnership_movie` (`partnership_id`, `movie_id`),
  INDEX `idx_partnership_id` (`partnership_id`),
  INDEX `idx_movie_id` (`movie_id`),
  INDEX `idx_matched_at` (`matched_at`),
  INDEX `idx_watched` (`watched`),
  FOREIGN KEY (`partnership_id`) REFERENCES `partnerships`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- FAVORITES (unverändert) ---------------------------------------
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

-- REFRESH TOKENS (unverändert) ----------------------------------
CREATE TABLE `refresh_tokens` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `family_id` VARCHAR(36) NOT NULL COMMENT 'Groups tokens for rotation detection',
  `expires_at` DATETIME NOT NULL,
  `revoked` BOOLEAN DEFAULT FALSE,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `unique_token_hash` (`token_hash`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_family_id` (`family_id`),
  INDEX `idx_expires_at` (`expires_at`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PASSWORD RESET TOKENS (unverändert) ---------------------------
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

-- Done
SELECT 'Database schema created successfully!' AS status;
