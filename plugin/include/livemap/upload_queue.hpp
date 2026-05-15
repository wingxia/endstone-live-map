#pragma once

#include <cstddef>
#include <deque>
#include <optional>
#include <utility>

namespace livemap {

enum class UploadPriority {
    Low,
    Normal,
    High,
};

template <typename T>
class PrioritizedUploadQueue {
public:
    bool push(T item, UploadPriority priority, std::size_t max_size)
    {
        if (size() >= max_size) {
            return false;
        }
        queueFor(priority).push_back(std::move(item));
        return true;
    }

    std::optional<T> pop()
    {
        if (!high_.empty()) {
            return popFrom(high_);
        }
        if (!normal_.empty()) {
            return popFrom(normal_);
        }
        if (!low_.empty()) {
            return popFrom(low_);
        }
        return std::nullopt;
    }

    [[nodiscard]] std::size_t size() const
    {
        return high_.size() + normal_.size() + low_.size();
    }

    [[nodiscard]] bool empty() const
    {
        return size() == 0;
    }

    void clear()
    {
        high_.clear();
        normal_.clear();
        low_.clear();
    }

private:
    std::deque<T> &queueFor(UploadPriority priority)
    {
        switch (priority) {
        case UploadPriority::High:
            return high_;
        case UploadPriority::Normal:
            return normal_;
        case UploadPriority::Low:
            return low_;
        }
        return normal_;
    }

    static std::optional<T> popFrom(std::deque<T> &queue)
    {
        T item = std::move(queue.front());
        queue.pop_front();
        return item;
    }

    std::deque<T> high_;
    std::deque<T> normal_;
    std::deque<T> low_;
};

template <typename T>
class LatestUploadSlot {
public:
    bool replace(T item)
    {
        const bool replaced = item_.has_value();
        item_ = std::move(item);
        if (replaced) {
            ++replaced_count_;
        }
        return replaced;
    }

    std::optional<T> take()
    {
        if (!item_.has_value()) {
            return std::nullopt;
        }
        std::optional<T> item(std::move(*item_));
        item_.reset();
        return item;
    }

    [[nodiscard]] std::size_t size() const
    {
        return item_.has_value() ? 1 : 0;
    }

    [[nodiscard]] bool empty() const
    {
        return !item_.has_value();
    }

    [[nodiscard]] std::size_t replacedCount() const
    {
        return replaced_count_;
    }

    void clear()
    {
        item_.reset();
    }

private:
    std::optional<T> item_;
    std::size_t replaced_count_ = 0;
};

}  // namespace livemap
