# frozen_string_literal: true

# == Schema Information
#
# Table name: queued_messages
#
#  id            :integer          not null, primary key
#  server_id     :integer
#  message_id    :integer
#  domain        :string(255)
#  locked_by     :string(255)
#  locked_at     :datetime
#  retry_after   :datetime
#  created_at    :datetime
#  updated_at    :datetime
#  ip_address_id :integer
#  attempts      :integer          default(0)
#  route_id      :integer
#  manual        :boolean          default(FALSE)
#  batch_key     :string(255)
#
# Indexes
#
#  index_queued_messages_on_domain      (domain)
#  index_queued_messages_on_message_id  (message_id)
#  index_queued_messages_on_server_id   (server_id)
#

class QueuedMessage < ApplicationRecord

  include HasMessage
  include HasLocking

  belongs_to :server
  belongs_to :ip_address, optional: true

  before_create :allocate_ip_address

  scope :ready_with_delayed_retry, -> { where("retry_after IS NULL OR retry_after < ?", 30.seconds.ago) }
  scope :with_stale_lock, -> { where("locked_at IS NOT NULL AND locked_at < ?", Postal::Config.postal.queued_message_lock_stale_days.days.ago) }

  def retry_now
    update!(retry_after: nil)
  end

  def send_bounce
    return unless message.send_bounces?

    BounceMessage.new(server, message).queue
  end

  def allocate_ip_address
    return unless Postal.ip_pools?
    return if message.nil?

    pool = server.ip_pool_for_message(message)
    return if pool.nil?

    self.ip_address = pool.ip_addresses.select_by_priority
  end

  # Lock and return the other queued messages that can be delivered in the same SMTP
  # session as this one.
  #
  # Both queries here additionally filter on `domain` where that is provably redundant.
  # The reason is index coverage: `queued_messages` carries exactly three indexes —
  # `domain` (8-character prefix), `message_id` and `server_id` — and neither `batch_key`
  # nor `ip_address_id` is among them. Without a predicate on `domain` MySQL has nothing
  # to seek on and scans the table by primary key, stopping only when it has collected
  # `limit` rows or reached the end.
  #
  # Reaching `limit` is the case that does not happen once an IP pool is in use. A batch
  # candidate must match BOTH the recipient domain and the outbound address, and
  # `allocate_ip_address` picks the address at random, so a pool of N addresses divides the
  # candidates by N. With a pool of 254 a hundred candidates would require some 25 000
  # queue rows of a single domain, which no long-tail domain ever has. So for most
  # messages the query runs to the end of the table — once here and once in the second
  # query below — for every message the worker delivers.
  #
  # @param [Integer] limit The maximum number of other messages to claim
  # @return [ActiveRecord::Relation, Array]
  def batchable_messages(limit = 10)
    unless locked?
      raise Postal::Error, "Must lock current message before locking any friends"
    end

    if batch_key.nil?
      []
    else
      time = Time.now
      locker = Postal.locker_name

      claimable = self.class.ready.where(batch_key: batch_key, ip_address_id: ip_address_id, locked_by: nil, locked_at: nil)
      claimable = claimable.where(domain: domain) if batch_key_derived_from_domain?
      claimable.limit(limit).update_all(locked_by: locker, locked_at: time)

      claimed = QueuedMessage.where(batch_key: batch_key, ip_address_id: ip_address_id, locked_by: locker, locked_at: time)
      claimed = claimed.where(domain: domain) if batch_key_derived_from_domain?
      claimed.where.not(id: id)
    end
  end

  private

  # Whether this row's `batch_key` is a function of its `domain`, which is what makes
  # filtering on `domain` redundant rather than merely usually true.
  #
  # `Message#add_to_message_queue` writes both columns from the same `recipient_domain`,
  # and `Message#batch_key` builds an outgoing key as "outgoing-" plus that domain, so for
  # an outgoing message every row sharing this `batch_key` also shares this `domain`.
  # Incoming keys are built from the route and the endpoint instead and carry no such
  # relation, hence the check.
  #
  # It compares the values actually stored on this row rather than assuming the invariant.
  # That matters for the failure mode: a legacy or truncated row whose `domain` does not
  # match its `batch_key` simply falls out of the batch and gets delivered in a session of
  # its own. It is never lost, never claimed twice and never delivered twice — the worst
  # outcome of this optimisation is a message that was not batched.
  #
  # @return [Boolean]
  def batch_key_derived_from_domain?
    batch_key == "outgoing-#{domain}"
  end

end
