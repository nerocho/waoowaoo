ALTER TABLE `novel_promotion_locations`
  ADD COLUMN `assetKind` VARCHAR(191) NOT NULL DEFAULT 'location';

ALTER TABLE `global_locations`
  ADD COLUMN `assetKind` VARCHAR(191) NOT NULL DEFAULT 'location';

ALTER TABLE `novel_promotion_clips`
  ADD COLUMN `props` TEXT NULL;

ALTER TABLE `novel_promotion_panels`
  ADD COLUMN `props` TEXT NULL;
