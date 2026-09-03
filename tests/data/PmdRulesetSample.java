package smith.fixtures;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

import org.apache.log4j.Logger;

/**
 * Two things PMD has to say about one file, and only one of them is a defect.
 *
 * <p>{@code loadCode} leaks a PreparedStatement and a ResultSet on every call. That is
 * CloseResource, and the review has to report it.
 *
 * <p>{@code describe} logs with concatenation and no {@code isDebugEnabled()} guard. That is
 * GuardLogStatement — 53 findings on the corpus slice, all 53 of them critical, not one of them a
 * bug — so the review has to stay quiet about it.
 */
public class PmdRulesetSample {

    private static final Logger LOG = Logger.getLogger(PmdRulesetSample.class);

    private final Connection connection;

    public PmdRulesetSample(final Connection connection) {
        this.connection = connection;
    }

    public String loadCode(final int id) throws SQLException {
        final PreparedStatement statement =
                connection.prepareStatement("select code from items where id = ?");
        statement.setInt(1, id);
        final ResultSet rows = statement.executeQuery();
        return rows.next() ? rows.getString(1) : null;
    }

    public void describe(final String code) {
        LOG.debug("resolved product " + code + " from the database");
    }
}
