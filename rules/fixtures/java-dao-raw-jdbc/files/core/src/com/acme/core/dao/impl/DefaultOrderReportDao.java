package com.acme.core.dao.impl;

import de.hybris.platform.servicelayer.search.FlexibleSearchService;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

public class DefaultOrderReportDao
{
   private static final String ORDER_CODES_SINCE =
         "SELECT p_code FROM orders WHERE p_date >= ?";

   private DataSource dataSource;
   private FlexibleSearchService flexibleSearchService;

   public List<String> findOrderCodesPlacedSince(final Date placedSince) throws SQLException
   {
      final List<String> codes = new ArrayList<>();
      try (final Connection connection = dataSource.getConnection();
            final PreparedStatement statement = connection.prepareStatement(ORDER_CODES_SINCE))
      {
         statement.setDate(1, placedSince);
         final ResultSet rows = statement.executeQuery();
         while (rows.next())
         {
            codes.add(rows.getString(1));
         }
      }
      return codes;
   }

   public void setDataSource(final DataSource dataSource)
   {
      this.dataSource = dataSource;
   }
}
